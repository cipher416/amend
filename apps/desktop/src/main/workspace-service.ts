import { randomUUID } from "node:crypto"
import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises"
import { basename, extname, join, relative, resolve } from "node:path"

import { isReadWikiFileInput } from "@workspace/contract"
import type {
  AmendError,
  AmendErrorCode,
  CancelIngestInput,
  CreateWorkspaceInput,
  IngestDocumentInput,
  IngestPastedSourceResult,
  ReadWikiFileInput,
  SourceDocumentSelection,
  StartIngestResult,
  WikiFileContent,
  WikiFileTreeItem,
  WikiIngestChangedEvent,
  WikiIngestJob,
  WikiIndexRefreshSummary,
  WikiProgressEvent,
  WikiSearchInput,
  WikiSearchResult,
  WikiTagFacet,
  WorkspaceParentSelection,
  WorkspaceListItem,
  WorkspaceSummary,
} from "@workspace/contract"
import type {
  PiProgressEvent,
  PiAgentSettings,
} from "@workspace/wiki-engine/agent/pi"
import { openWikiIndex, WikiIndexError } from "@workspace/wiki-engine/index"
import type { WikiIndex } from "@workspace/wiki-engine/index"
import { createWikiEngine } from "@workspace/wiki-engine/ingest"
import type { WikiAgent, WikiEngine } from "@workspace/wiki-engine/ingest"
import {
  migrateWorkspace,
  readWorkspace,
} from "@workspace/wiki-engine/workspace"
import type { WikiWorkspace } from "@workspace/wiki-engine/workspace"

import { WorkspaceCatalog } from "./workspace-catalog.ts"

interface ActiveWorkspace {
  summary: WorkspaceSummary
  workspacePath: string
  index: WikiIndex
}

interface ParentSelection {
  ownerId: number
  parentPath: string
}

interface SelectedDocument {
  ownerId: number
  workspaceId?: string
  path: string
  displayName: string
  title: string
  extension: string
}

interface WorkspaceCatalogApi {
  listWorkspaces: WorkspaceCatalog["listWorkspaces"]
  findLastActiveWorkspace: WorkspaceCatalog["findLastActiveWorkspace"]
  upsertAndActivate: WorkspaceCatalog["upsertAndActivate"]
  clearLastActive: WorkspaceCatalog["clearLastActive"]
}

interface RunningIngest {
  workspaceId: string
  jobId: string
  controller: AbortController
}

interface WorkspaceServiceOptions {
  userDataPath: string
  skillPath: string
  createId?: () => string
  now?: () => Date
  createAgent?: (
    onProgress: (event: PiProgressEvent) => void
  ) => Promise<WikiAgent>
  createEngine?: (agent: WikiAgent) => WikiEngine
  openIndex?: (options: {
    workspacePath: string
    databasePath: string
  }) => Promise<WikiIndex>
  catalog?: WorkspaceCatalogApi
  readWorkspace?: (input: { workspacePath: string }) => Promise<WikiWorkspace>
  migrateWorkspace?: (input: {
    workspacePath: string
  }) => Promise<WikiWorkspace>
}

export class WorkspaceServiceError extends Error {
  readonly code: AmendErrorCode

  constructor(code: AmendErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "WorkspaceServiceError"
    this.code = code
  }
}

export class WorkspaceService {
  private readonly options: WorkspaceServiceOptions
  private readonly createId: () => string
  private readonly now: () => Date
  private readonly catalog: WorkspaceCatalogApi
  private readonly selections = new Map<string, ParentSelection>()
  private readonly documents = new Map<string, SelectedDocument>()
  private readonly contexts = new Map<string, ActiveWorkspace>()
  private readonly jobs = new Map<string, WikiIngestJob>()
  private readonly jobListeners = new Set<
    (event: WikiIngestChangedEvent) => void
  >()
  private active: ActiveWorkspace | undefined
  private lifecycleOperation: Promise<unknown> | undefined
  private modelOperation: Promise<unknown> | undefined
  private runningIngest: RunningIngest | undefined
  private disposed = false

  constructor(options: WorkspaceServiceOptions) {
    this.options = options
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.catalog =
      options.catalog ??
      new WorkspaceCatalog({ userDataPath: options.userDataPath })
  }

  subscribeIngestChanged(
    listener: (event: WikiIngestChangedEvent) => void
  ): () => void {
    this.jobListeners.add(listener)
    return () => this.jobListeners.delete(listener)
  }

  async registerParentSelection(
    ownerId: number,
    parentPath: string
  ): Promise<WorkspaceParentSelection> {
    this.assertOpen()
    const canonicalParent = await realpath(resolve(parentPath)).catch(
      (error) => {
        throw new WorkspaceServiceError(
          "invalid-location",
          "The selected workspace location is not available.",
          { cause: error }
        )
      }
    )
    for (const [token, selection] of this.selections) {
      if (selection.ownerId === ownerId) this.selections.delete(token)
    }
    const token = tokenFromId(this.createId())
    this.selections.set(token, { ownerId, parentPath: canonicalParent })
    return { token, displayPath: canonicalParent }
  }

  async createWorkspace(
    ownerId: number,
    input: CreateWorkspaceInput
  ): Promise<WorkspaceSummary> {
    this.assertOpen()
    if (this.lifecycleOperation) {
      throw new WorkspaceServiceError("busy", "Amend is already working.")
    }
    const selection = this.selections.get(input.selectionToken)
    if (!selection || selection.ownerId !== ownerId) {
      throw new WorkspaceServiceError(
        "invalid-location",
        "Choose the workspace location again."
      )
    }
    this.selections.delete(input.selectionToken)
    const workspacePath = join(selection.parentPath, input.name)
    const operation = Promise.resolve().then(async () => {
      await assertTargetDoesNotExist(workspacePath)
      return await this.initializeWorkspace(workspacePath, input)
    })
    this.lifecycleOperation = operation
    try {
      return await operation
    } finally {
      if (this.lifecycleOperation === operation) {
        this.lifecycleOperation = undefined
      }
    }
  }

  async registerSourceDocument(
    ownerId: number,
    documentPath: string
  ): Promise<SourceDocumentSelection> {
    this.assertOpen()
    const workspaceId = this.active?.summary.id
    const path = await realpath(resolve(documentPath)).catch((error) => {
      throw new WorkspaceServiceError(
        "invalid-input",
        "The selected document is not available.",
        { cause: error }
      )
    })
    const metadata = await lstat(path)
    const extension = extname(path).toLowerCase()
    if (
      !metadata.isFile() ||
      ![".pdf", ".md", ".markdown", ".txt", ".text"].includes(extension)
    ) {
      throw new WorkspaceServiceError(
        "invalid-input",
        "Choose a PDF, Markdown, or text document."
      )
    }
    if (metadata.size > 25_000_000) {
      throw new WorkspaceServiceError(
        "invalid-input",
        "The document must be no larger than 25 MB."
      )
    }

    for (const [token, document] of this.documents) {
      if (document.ownerId === ownerId) this.documents.delete(token)
    }
    const displayName = basename(path)
    const title = displayName.slice(0, -extension.length).trim() || "Document"
    const token = tokenFromId(this.createId()).replace(
      "selection_",
      "document_"
    )
    this.documents.set(token, {
      ownerId,
      ...(workspaceId ? { workspaceId } : {}),
      path,
      displayName,
      title,
      extension,
    })
    return { token, displayName, suggestedTitle: title }
  }

  getCurrentWorkspace(): WorkspaceSummary | null {
    this.assertOpen()
    return this.active?.summary ?? null
  }

  async listWorkspaces(): Promise<readonly WorkspaceListItem[]> {
    this.assertOpen()
    const records = await this.catalog.listWorkspaces()
    return records.map((record) => ({
      id: record.id,
      name: basename(record.path) || record.path,
      displayPath: record.path,
      active: this.active?.summary.id === record.id,
      running: this.jobs.get(record.id)?.status === "running",
    }))
  }

  async activateWorkspace(workspaceId: string): Promise<WorkspaceSummary> {
    this.assertOpen()
    if (this.lifecycleOperation) {
      throw new WorkspaceServiceError("busy", "Amend is already working.")
    }
    const operation = Promise.resolve().then(async () => {
      const record = (await this.catalog.listWorkspaces()).find(
        ({ id }) => id === workspaceId
      )
      if (!record) {
        throw new WorkspaceServiceError(
          "invalid-input",
          "The workspace was not found."
        )
      }
      return await this.openAndActivateWorkspace(record.path, record.id)
    })
    this.lifecycleOperation = operation
    try {
      return await operation
    } finally {
      if (this.lifecycleOperation === operation) {
        this.lifecycleOperation = undefined
      }
    }
  }

  async openWorkspace(workspacePath: string): Promise<WorkspaceSummary> {
    this.assertOpen()
    if (this.lifecycleOperation) {
      throw new WorkspaceServiceError("busy", "Amend is already working.")
    }
    const operation = Promise.resolve().then(() =>
      this.openAndActivateWorkspace(workspacePath)
    )
    this.lifecycleOperation = operation
    try {
      return await operation
    } finally {
      if (this.lifecycleOperation === operation) {
        this.lifecycleOperation = undefined
      }
    }
  }

  async restoreLastActiveWorkspace(): Promise<WorkspaceSummary | null> {
    this.assertOpen()
    if (this.lifecycleOperation) {
      throw new WorkspaceServiceError("busy", "Amend is already working.")
    }
    const operation = Promise.resolve().then(async () => {
      let record
      try {
        record = await this.catalog.findLastActiveWorkspace()
      } catch (error) {
        console.error("[amend] failed to read the workspace catalog:", error)
        return null
      }
      if (!record) {
        await this.catalog.clearLastActive().catch((error: unknown) => {
          console.error(
            "[amend] failed to clear an invalid active workspace record:",
            error
          )
        })
        return null
      }

      try {
        return await this.openAndActivateWorkspace(record.path, record.id)
      } catch (error) {
        console.error("[amend] failed to restore the last workspace:", error)
        await this.catalog.clearLastActive().catch((clearError: unknown) => {
          console.error(
            "[amend] failed to clear the stale active workspace:",
            clearError
          )
        })
        return null
      }
    })
    this.lifecycleOperation = operation
    try {
      return await operation
    } finally {
      if (this.lifecycleOperation === operation) {
        this.lifecycleOperation = undefined
      }
    }
  }

  getCurrentIngest(): WikiIngestJob | null {
    this.assertOpen()
    return this.active ? (this.jobs.get(this.active.summary.id) ?? null) : null
  }

  async startIngest(
    ownerId: number,
    input: IngestDocumentInput
  ): Promise<StartIngestResult> {
    this.assertOpen()
    const active = this.requireActive()
    if (this.modelOperation) {
      throw new WorkspaceServiceError("busy", "Amend is already working.")
    }
    const document = this.documents.get(input.documentToken)
    if (
      !document ||
      document.ownerId !== ownerId ||
      (document.workspaceId !== undefined &&
        document.workspaceId !== active.summary.id)
    ) {
      throw new WorkspaceServiceError(
        "invalid-input",
        "Choose the source document again."
      )
    }
    this.documents.delete(input.documentToken)

    const jobId = this.nextJobId()
    const timestamp = this.now().toISOString()
    const job: WikiIngestJob = {
      id: jobId,
      title: document.title,
      status: "running",
      phase: "preparing",
      message: "Preparing the source",
      startedAt: timestamp,
      updatedAt: timestamp,
      revision: 0,
      cancellable: true,
    }
    this.jobs.set(active.summary.id, job)
    const controller = new AbortController()
    const operation = Promise.resolve().then(() =>
      this.ingest(active, jobId, document, input.objective, controller.signal)
    )
    this.modelOperation = operation
    this.runningIngest = {
      workspaceId: active.summary.id,
      jobId,
      controller,
    }
    this.emitJob(active.summary.id)
    void operation
      .then(
        (result) => this.completeIngest(active.summary.id, jobId, result),
        (error: unknown) => this.failIngest(active.summary.id, jobId, error)
      )
      .finally(() => {
        if (this.modelOperation === operation) this.modelOperation = undefined
        if (
          this.runningIngest?.workspaceId === active.summary.id &&
          this.runningIngest.jobId === jobId
        ) {
          this.runningIngest = undefined
        }
      })
    return { jobId }
  }

  cancelIngest(input: CancelIngestInput): void {
    this.assertOpen()
    const entry = [...this.jobs.entries()].find(
      ([, job]) => job.id === input.jobId
    )
    if (!entry) {
      throw new WorkspaceServiceError(
        "invalid-input",
        "The ingest job was not found."
      )
    }
    const [workspaceId, job] = entry
    if (job.status !== "running") return
    if (!job.cancellable) {
      throw new WorkspaceServiceError(
        "operation-failed",
        "The ingest can no longer be cancelled because its commit has started."
      )
    }
    if (
      this.runningIngest?.workspaceId !== workspaceId ||
      this.runningIngest.jobId !== input.jobId
    ) {
      throw new WorkspaceServiceError(
        "invalid-input",
        "The ingest job was not found."
      )
    }
    this.runningIngest.controller.abort(
      new DOMException("The ingest was cancelled", "AbortError")
    )
  }

  async search(input: WikiSearchInput): Promise<readonly WikiSearchResult[]> {
    this.assertOpen()
    try {
      return await this.requireActive().index.search(input)
    } catch (error) {
      throw indexOperationError(error, "The wiki could not be searched.")
    }
  }

  async listTags(): Promise<readonly WikiTagFacet[]> {
    this.assertOpen()
    try {
      return await this.requireActive().index.listTags()
    } catch (error) {
      throw indexOperationError(error, "Wiki tags could not be loaded.")
    }
  }

  async listFiles(): Promise<readonly WikiFileTreeItem[]> {
    this.assertOpen()
    const active = this.requireActive()
    try {
      return await listWorkspaceFiles(active.workspacePath)
    } catch (error) {
      throw new WorkspaceServiceError(
        "operation-failed",
        "Workspace files could not be loaded.",
        { cause: error }
      )
    }
  }

  async readFile(input: ReadWikiFileInput): Promise<WikiFileContent> {
    this.assertOpen()
    const active = this.requireActive()
    if (!isReadWikiFileInput(input)) {
      throw new WorkspaceServiceError("invalid-input", "Choose a wiki file.")
    }
    const { absolutePath, relativePath } = workspaceFilePath(
      active.workspacePath,
      input.path
    )
    const metadata = await lstat(absolutePath).catch((error) => {
      throw new WorkspaceServiceError(
        "invalid-input",
        "The selected wiki file is not available.",
        { cause: error }
      )
    })
    if (!metadata.isFile()) {
      throw new WorkspaceServiceError("invalid-input", "Choose a wiki file.")
    }
    const mediaType = wikiFileMediaType(relativePath)
    if (mediaType === "binary") {
      return {
        path: relativePath,
        name: basename(relativePath),
        mediaType,
        size: metadata.size,
      }
    }
    if (metadata.size > 1_000_000) {
      throw new WorkspaceServiceError(
        "invalid-input",
        "The selected text file is too large to preview."
      )
    }
    const content = (await readFile(absolutePath)).toString("utf8")
    if (content.includes("\0")) {
      throw new WorkspaceServiceError(
        "invalid-input",
        "The selected wiki file is not valid UTF-8 text."
      )
    }
    return {
      path: relativePath,
      name: basename(relativePath),
      mediaType,
      size: metadata.size,
      content: content.replace(/^\uFEFF/, ""),
    }
  }

  async refreshIndex(): Promise<WikiIndexRefreshSummary> {
    this.assertOpen()
    if (this.modelOperation) {
      throw new WorkspaceServiceError("busy", "Amend is already working.")
    }
    const active = this.requireActive()
    const operation = Promise.resolve().then(async () => {
      try {
        return await active.index.refresh()
      } catch (error) {
        throw indexOperationError(
          error,
          "The wiki search index could not be refreshed."
        )
      }
    })
    this.modelOperation = operation
    try {
      const summary = await operation
      const job = this.jobs.get(active.summary.id)
      if (
        job?.status === "completed" &&
        job.result?.index.status === "failed"
      ) {
        this.jobs.set(active.summary.id, {
          ...job,
          updatedAt: this.now().toISOString(),
          revision: job.revision + 1,
          result: {
            ...job.result,
            index: { status: "ready", summary },
          },
        })
        this.emitJob(active.summary.id)
      }
      return summary
    } finally {
      if (this.modelOperation === operation) this.modelOperation = undefined
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const running = this.runningIngest
    if (running && this.jobs.get(running.workspaceId)?.cancellable) {
      running.controller.abort(
        new DOMException("The ingest was cancelled", "AbortError")
      )
    }
    await Promise.all([
      this.lifecycleOperation?.catch(() => undefined),
      this.modelOperation?.catch(() => undefined),
    ])
    await Promise.all(
      [...this.contexts.values()].map(({ index }) =>
        index.close().catch((error: unknown) => {
          console.error("[amend] failed to close a wiki index:", error)
        })
      )
    )
    this.active = undefined
    this.contexts.clear()
    this.jobs.clear()
    this.selections.clear()
    this.documents.clear()
    this.jobListeners.clear()
  }

  private async initializeWorkspace(
    workspacePath: string,
    input: CreateWorkspaceInput
  ): Promise<WorkspaceSummary> {
    const placeholderAgent: WikiAgent = {
      name: "amend/initializer",
      async run() {
        throw new Error("The initialization agent cannot ingest sources")
      },
    }
    const engine = this.createEngine(placeholderAgent)
    let initialized = false
    let index: WikiIndex | undefined

    try {
      const wiki = await engine.initialize({
        workspacePath,
        domain: input.domain,
      })
      initialized = true
      const canonicalPath = await realpath(wiki.workspacePath)
      index = await this.openWorkspaceIndex(canonicalPath, wiki.id)
      await index.refresh()
      const summary: WorkspaceSummary = {
        id: wiki.id,
        name: input.name,
        domain: input.domain.trim(),
        displayPath: canonicalPath,
        commitHash: wiki.commitHash,
        setupStatus: "initialized",
      }
      await this.setActiveWorkspace({
        summary,
        workspacePath: canonicalPath,
        index,
      })
      return summary
    } catch (error) {
      await index?.close().catch(() => undefined)
      if (initialized) {
        await rm(workspacePath, { recursive: true, force: true }).catch(
          () => undefined
        )
      }
      if (isGitUnavailable(error)) {
        throw new WorkspaceServiceError(
          "git-unavailable",
          "Git is required to create an Amend wiki.",
          { cause: error }
        )
      }
      if (error instanceof WorkspaceServiceError) throw error
      throw new WorkspaceServiceError(
        "workspace-creation-failed",
        "The wiki workspace could not be created.",
        { cause: error }
      )
    }
  }

  private async openAndActivateWorkspace(
    workspacePath: string,
    expectedId?: string
  ): Promise<WorkspaceSummary> {
    let index: WikiIndex | undefined
    try {
      const canonicalPath = await realpath(resolve(workspacePath))
      const wiki = await this.readOrMigrateWorkspace(canonicalPath)
      if (expectedId !== undefined && wiki.id !== expectedId) {
        throw new Error("The workspace ID does not match the catalog record")
      }
      const existing = this.contexts.get(wiki.id)
      if (existing?.workspacePath === canonicalPath) {
        await this.setActiveWorkspace(existing)
        return existing.summary
      }
      index = await this.openWorkspaceIndex(canonicalPath, wiki.id, existing)
      const refresh = await index.refresh()
      const summary: WorkspaceSummary = {
        id: wiki.id,
        name: basename(canonicalPath) || canonicalPath,
        domain: wiki.domain,
        displayPath: canonicalPath,
        commitHash: refresh.commitHash,
        setupStatus: wiki.setupStatus,
      }
      await this.setActiveWorkspace({
        summary,
        workspacePath: canonicalPath,
        index,
      })
      return summary
    } catch (error) {
      await index?.close().catch(() => undefined)
      if (error instanceof WorkspaceServiceError) throw error
      if (isGitUnavailable(error)) {
        throw new WorkspaceServiceError(
          "git-unavailable",
          "Git is required to open an Amend wiki.",
          { cause: error }
        )
      }
      throw new WorkspaceServiceError(
        "workspace-open-failed",
        "The wiki workspace could not be opened.",
        { cause: error }
      )
    }
  }

  private async readOrMigrateWorkspace(
    workspacePath: string
  ): Promise<WikiWorkspace> {
    try {
      return await (this.options.readWorkspace ?? readWorkspace)({
        workspacePath,
      })
    } catch {
      return await (this.options.migrateWorkspace ?? migrateWorkspace)({
        workspacePath,
      })
    }
  }

  private async setActiveWorkspace(candidate: ActiveWorkspace): Promise<void> {
    await this.catalog.upsertAndActivate({
      id: candidate.summary.id,
      path: candidate.workspacePath,
    })

    const replaced = this.contexts.get(candidate.summary.id)
    this.contexts.set(candidate.summary.id, candidate)
    this.active = candidate
    if (replaced && replaced !== candidate) {
      await replaced.index.close().catch((error: unknown) => {
        console.error("[amend] failed to close a replaced wiki index:", error)
      })
    }
  }

  private async openWorkspaceIndex(
    workspacePath: string,
    workspaceId: string,
    replaced?: ActiveWorkspace
  ): Promise<WikiIndex> {
    const databasePath = indexPath(this.options.userDataPath, workspaceId)
    const open = this.options.openIndex ?? openWikiIndex
    try {
      return await open({ workspacePath, databasePath })
    } catch (error) {
      if (
        !(error instanceof WikiIndexError) ||
        error.code !== "invalid-database"
      ) {
        throw error
      }

      // The index is a derived cache. A moved workspace keeps its stable ID but
      // needs a fresh cache because older indexes are bound to the prior path.
      if (replaced) await this.closeWorkspaceContext(workspaceId, replaced)
      await Promise.all(
        [databasePath, `${databasePath}-shm`, `${databasePath}-wal`].map(
          (path) => rm(path, { force: true })
        )
      )
      return await open({ workspacePath, databasePath })
    }
  }

  private async closeWorkspaceContext(
    workspaceId: string,
    context: ActiveWorkspace
  ): Promise<void> {
    if (this.contexts.get(workspaceId) === context) {
      this.contexts.delete(workspaceId)
    }
    if (this.active === context) this.active = undefined
    await context.index.close().catch((error: unknown) => {
      console.error("[amend] failed to close a replaced wiki index:", error)
    })
  }

  private async ingest(
    active: ActiveWorkspace,
    jobId: string,
    document: SelectedDocument,
    objective: string,
    signal: AbortSignal
  ): Promise<IngestPastedSourceResult> {
    const workspaceId = active.summary.id
    try {
      this.updateJob(workspaceId, jobId, {
        phase: "preparing",
        message: "Preparing the source",
      })
      const agent = await this.createAgent((event) =>
        this.updateJob(workspaceId, jobId, piProgress(event))
      )
      signal.throwIfAborted()
      const engine = this.createEngine(agent)
      const sourceText = await extractDocumentText(document)
      if (Buffer.byteLength(sourceText, "utf8") > 5_000_000) {
        throw new WorkspaceServiceError(
          "invalid-input",
          "The extracted document text must be no larger than 5 MB."
        )
      }
      const sourceDirectory =
        document.extension === ".pdf" ? "papers" : "articles"
      const sourcePath = `raw/${sourceDirectory}/${sourceSlug(document.title, this.createId())}.md`
      const run = await engine.ingest({
        workspacePath: active.workspacePath,
        sources: [
          { path: sourcePath, title: document.title, content: sourceText },
        ],
        instruction: objective,
        signal,
        onCommitStart: () =>
          this.updateJob(workspaceId, jobId, {
            phase: "committing",
            message: "Committing the wiki changes",
            cancellable: false,
          }),
      })
      this.updateJob(workspaceId, jobId, {
        phase: "indexing",
        message: "Indexing the new knowledge",
        cancellable: false,
      })
      const index: IngestPastedSourceResult["index"] = await active.index
        .refresh()
        .then(
          (summary) => ({ status: "ready", summary }),
          () => ({
            status: "failed",
            error: {
              code: "index-failed",
              message:
                "The source was saved, but the search index could not be refreshed.",
            },
          })
        )
      return {
        runId: run.runId,
        commitHash: run.commitHash,
        changedFiles: run.changedFiles,
        summary: run.summary,
        ...(run.usage ? { usage: run.usage } : {}),
        index,
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw new WorkspaceServiceError(
          "cancelled",
          "The ingest was cancelled.",
          { cause: error }
        )
      }
      if (error instanceof WorkspaceServiceError) throw error
      console.error("[amend] ingest failed:", error)
      if (isGitUnavailable(error)) {
        throw new WorkspaceServiceError(
          "git-unavailable",
          "Git is required to integrate a source into the wiki.",
          { cause: error }
        )
      }
      throw new WorkspaceServiceError(
        "ingest-failed",
        ingestFailureMessage(error),
        { cause: error }
      )
    }
  }

  private async createAgent(
    onProgress: (event: PiProgressEvent) => void
  ): Promise<WikiAgent> {
    if (this.options.createAgent)
      return await this.options.createAgent(onProgress)
    let settings: PiAgentSettings
    const { createPiWikiAgent, readPiAgentSettings } =
      await import("@workspace/wiki-engine/agent/pi")
    try {
      settings = await readPiAgentSettings()
    } catch (error) {
      throw new WorkspaceServiceError(
        "pi-configuration-missing",
        "Configure a default Pi provider and model before ingesting a source.",
        { cause: error }
      )
    }
    return createPiWikiAgent({
      ...settings,
      skillPath: this.options.skillPath,
      onProgress,
    })
  }

  private createEngine(agent: WikiAgent): WikiEngine {
    return this.options.createEngine?.(agent) ?? createWikiEngine({ agent })
  }

  private requireActive(): ActiveWorkspace {
    if (!this.active) {
      throw new WorkspaceServiceError(
        "no-active-workspace",
        "Create a wiki workspace first."
      )
    }
    return this.active
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new WorkspaceServiceError("cancelled", "Amend is shutting down.")
    }
  }

  private updateJob(
    workspaceId: string,
    jobId: string,
    update: Partial<Pick<WikiIngestJob, "phase" | "message" | "cancellable">>
  ): void {
    const job = this.jobs.get(workspaceId)
    if (!job || job.id !== jobId || job.status !== "running") return
    this.jobs.set(workspaceId, {
      ...job,
      ...update,
      updatedAt: this.now().toISOString(),
      revision: job.revision + 1,
    })
    this.emitJob(workspaceId)
  }

  private completeIngest(
    workspaceId: string,
    jobId: string,
    result: IngestPastedSourceResult
  ): void {
    const job = this.jobs.get(workspaceId)
    if (!job || job.id !== jobId) return
    const context = this.contexts.get(workspaceId)
    if (context) {
      const updated: ActiveWorkspace = {
        ...context,
        summary: {
          ...context.summary,
          commitHash: result.commitHash,
          setupStatus: "ready",
        },
      }
      this.contexts.set(workspaceId, updated)
      if (this.active?.summary.id === workspaceId) this.active = updated
    }
    this.jobs.set(workspaceId, {
      ...job,
      status: "completed",
      message:
        result.index.status === "ready"
          ? "The source is ready to search"
          : "The source was saved, but indexing needs to be retried",
      updatedAt: this.now().toISOString(),
      revision: job.revision + 1,
      cancellable: false,
      result,
    })
    this.emitJob(workspaceId)
  }

  private failIngest(workspaceId: string, jobId: string, error: unknown): void {
    const job = this.jobs.get(workspaceId)
    if (!job || job.id !== jobId) return
    const amendError = toAmendError(error)
    this.jobs.set(workspaceId, {
      ...job,
      status: amendError.code === "cancelled" ? "cancelled" : "failed",
      message: amendError.message,
      updatedAt: this.now().toISOString(),
      revision: job.revision + 1,
      cancellable: false,
      error: amendError,
    })
    this.emitJob(workspaceId)
  }

  private emitJob(workspaceId: string): void {
    const job = this.jobs.get(workspaceId)
    if (!job) return
    for (const listener of this.jobListeners) {
      try {
        listener({ workspaceId, job })
      } catch {
        // Renderer delivery must not affect the main-owned job.
      }
    }
  }

  private nextJobId(): string {
    const candidate = jobIdFrom(this.createId())
    return [...this.jobs.values()].some(({ id }) => id === candidate)
      ? jobIdFrom(randomUUID())
      : candidate
  }
}

const hiddenWorkspaceEntries = new Set([".amend", ".git"])
const maxFileTreeDepth = 8
const maxFileTreeEntries = 500

async function listWorkspaceFiles(
  workspacePath: string
): Promise<readonly WikiFileTreeItem[]> {
  let remaining = maxFileTreeEntries
  async function listDirectory(
    absolutePath: string,
    relativePath: string,
    depth: number
  ): Promise<WikiFileTreeItem[]> {
    if (depth > maxFileTreeDepth || remaining <= 0) return []
    const entries = await readdir(absolutePath, { withFileTypes: true })
    const visible = entries
      .filter((entry) => !hiddenWorkspaceEntries.has(entry.name))
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1
        }
        return left.name.localeCompare(right.name)
      })
    const items: WikiFileTreeItem[] = []
    for (const entry of visible) {
      if (remaining <= 0) break
      remaining -= 1
      const path = relativePath ? `${relativePath}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        items.push({
          path,
          name: entry.name,
          kind: "directory",
          children: await listDirectory(
            join(absolutePath, entry.name),
            path,
            depth + 1
          ),
        })
      } else {
        items.push({ path, name: entry.name, kind: "file" })
      }
    }
    return items
  }
  return await listDirectory(workspacePath, "", 0)
}

function workspaceFilePath(
  workspacePath: string,
  inputPath: string
): { absolutePath: string; relativePath: string } {
  const root = resolve(workspacePath)
  const absolutePath = resolve(root, inputPath)
  const relativePath = relative(root, absolutePath)
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    resolve(root, relativePath) !== absolutePath ||
    relativePath
      .split(/[/\\]/)
      .some((part) => hiddenWorkspaceEntries.has(part) || part.startsWith("."))
  ) {
    throw new WorkspaceServiceError("invalid-input", "Choose a wiki file.")
  }
  return { absolutePath, relativePath: relativePath.replaceAll("\\", "/") }
}

function wikiFileMediaType(path: string): WikiFileContent["mediaType"] {
  const extension = extname(path).toLowerCase()
  if ([".md", ".markdown"].includes(extension)) return "markdown"
  if ([".txt", ".text", ".json", ".yaml", ".yml"].includes(extension)) {
    return "text"
  }
  return "binary"
}

async function assertTargetDoesNotExist(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return
    throw new WorkspaceServiceError(
      "invalid-location",
      "The workspace location could not be checked.",
      { cause: error }
    )
  }
  throw new WorkspaceServiceError(
    "invalid-location",
    "A file or folder already exists at that workspace location."
  )
}

function indexPath(userDataPath: string, workspaceId: string): string {
  return join(userDataPath, "indexes", `${workspaceId}.sqlite`)
}

function tokenFromId(id: string): string {
  return `selection_${id.replace(/[^a-zA-Z0-9_-]/g, "")}`
}

function jobIdFrom(id: string): string {
  const suffix = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 121)
  return `ingest_${suffix || randomUUID().replaceAll("-", "")}`
}

function sourceSlug(title: string, id: string): string {
  const titleSlug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72)
  const suffix = id
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .slice(0, 8)
  return `${titleSlug || "pasted-source"}-${suffix || "source"}`
}

async function extractDocumentText(
  document: SelectedDocument
): Promise<string> {
  const data = await readFile(document.path)
  let text: string
  if (document.extension === ".pdf") {
    const { PDFParse } = await import("pdf-parse")
    const parser = new PDFParse({ data })
    try {
      text = (await parser.getText({ parseHyperlinks: true })).text
    } finally {
      await parser.destroy()
    }
  } else {
    text = data.toString("utf8").replace(/^\uFEFF/, "")
    if (text.includes("\0")) {
      throw new WorkspaceServiceError(
        "invalid-input",
        "The selected document is not valid UTF-8 text."
      )
    }
  }
  if (!text.trim()) {
    throw new WorkspaceServiceError(
      "invalid-input",
      "The selected document does not contain extractable text."
    )
  }
  return text
}

function piProgress(event: PiProgressEvent): WikiProgressEvent {
  switch (event.type) {
    case "retry":
      return { phase: "repairing", message: "Repairing validation issues" }
    case "turn-end":
      return { phase: "validating", message: "Validating the wiki changes" }
    case "tool-start":
      if (event.toolName === "write" || event.toolName === "edit") {
        return { phase: "writing", message: "Writing and linking wiki pages" }
      }
      return { phase: "reading", message: "Orienting within the wiki" }
    case "tool-end":
      return event.isError
        ? { phase: "repairing", message: "Recovering from a tool error" }
        : { phase: "reading", message: "Reviewing the wiki" }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function toAmendError(error: unknown): AmendError {
  if (error instanceof WorkspaceServiceError) {
    return { code: error.code, message: error.message }
  }
  return {
    code: "operation-failed",
    message: error instanceof Error ? error.message : "The operation failed.",
  }
}

function indexOperationError(
  error: unknown,
  message: string
): WorkspaceServiceError {
  return new WorkspaceServiceError(
    error instanceof WikiIndexError && error.code === "invalid-query"
      ? "invalid-input"
      : "index-failed",
    error instanceof WikiIndexError && error.code === "invalid-query"
      ? error.message
      : message,
    { cause: error }
  )
}

function ingestFailureMessage(error: unknown): string {
  const fallback = "The source could not be integrated into the wiki."
  if (!(error instanceof Error) || !error.message.trim()) return fallback
  const detail = error.message.trim().slice(0, 300)
  return `${fallback} (${detail})`
}

function isGitUnavailable(error: unknown): boolean {
  if (!isNodeError(error)) return false
  return error.code === "ENOENT" || /spawn\s+git\s+ENOENT/i.test(error.message)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}
