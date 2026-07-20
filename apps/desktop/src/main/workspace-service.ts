import { createHash, randomUUID } from "node:crypto"
import { lstat, readFile, realpath, rm } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"

import type {
  AmendError,
  AmendErrorCode,
  CancelIngestInput,
  CreateWorkspaceInput,
  IngestDocumentInput,
  IngestPastedSourceResult,
  SourceDocumentSelection,
  StartIngestResult,
  WikiIngestJob,
  WikiIndexRefreshSummary,
  WikiProgressEvent,
  WikiSearchInput,
  WikiSearchResult,
  WikiTagFacet,
  WorkspaceParentSelection,
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
  path: string
  displayName: string
  title: string
  extension: string
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
  private readonly selections = new Map<string, ParentSelection>()
  private readonly documents = new Map<string, SelectedDocument>()
  private readonly jobListeners = new Set<(job: WikiIngestJob) => void>()
  private active: ActiveWorkspace | undefined
  private currentJob: WikiIngestJob | undefined
  private operation: Promise<unknown> | undefined
  private ingestController: AbortController | undefined
  private disposed = false

  constructor(options: WorkspaceServiceOptions) {
    this.options = options
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  subscribeIngestChanged(listener: (job: WikiIngestJob) => void): () => void {
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
    if (this.operation) {
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
    this.operation = operation
    try {
      return await operation
    } finally {
      if (this.operation === operation) this.operation = undefined
    }
  }

  async registerSourceDocument(
    ownerId: number,
    documentPath: string
  ): Promise<SourceDocumentSelection> {
    this.assertOpen()
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

  getCurrentIngest(): WikiIngestJob | null {
    this.assertOpen()
    return this.currentJob ?? null
  }

  async startIngest(
    ownerId: number,
    input: IngestDocumentInput
  ): Promise<StartIngestResult> {
    this.assertOpen()
    const active = this.requireActive()
    if (this.operation) {
      throw new WorkspaceServiceError("busy", "Amend is already working.")
    }
    const document = this.documents.get(input.documentToken)
    if (!document || document.ownerId !== ownerId) {
      throw new WorkspaceServiceError(
        "invalid-input",
        "Choose the source document again."
      )
    }
    this.documents.delete(input.documentToken)

    const jobId = this.nextJobId()
    const timestamp = this.now().toISOString()
    this.currentJob = {
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
    const controller = new AbortController()
    this.ingestController = controller
    const operation = this.ingest(
      active,
      document,
      input.objective,
      controller.signal
    )
    this.operation = operation
    this.emitCurrentJob()
    void operation
      .then(
        (result) => this.completeIngest(jobId, result),
        (error: unknown) => this.failIngest(jobId, error)
      )
      .finally(() => {
        if (this.operation === operation) this.operation = undefined
        if (this.ingestController === controller) {
          this.ingestController = undefined
        }
      })
    return { jobId }
  }

  cancelIngest(input: CancelIngestInput): void {
    this.assertOpen()
    if (!this.currentJob || this.currentJob.id !== input.jobId) {
      throw new WorkspaceServiceError(
        "invalid-input",
        "The ingest job was not found."
      )
    }
    if (this.currentJob.status !== "running") return
    if (!this.currentJob.cancellable) {
      throw new WorkspaceServiceError(
        "operation-failed",
        "The ingest can no longer be cancelled because its commit has started."
      )
    }
    this.ingestController?.abort(
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

  async refreshIndex(): Promise<WikiIndexRefreshSummary> {
    this.assertOpen()
    if (this.operation) {
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
    this.operation = operation
    try {
      const summary = await operation
      if (
        this.currentJob?.status === "completed" &&
        this.currentJob.result?.index.status === "failed"
      ) {
        this.currentJob = {
          ...this.currentJob,
          updatedAt: this.now().toISOString(),
          revision: this.currentJob.revision + 1,
          result: {
            ...this.currentJob.result,
            index: { status: "ready", summary },
          },
        }
        this.emitCurrentJob()
      }
      return summary
    } finally {
      if (this.operation === operation) this.operation = undefined
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.currentJob?.cancellable) {
      this.ingestController?.abort(
        new DOMException("The ingest was cancelled", "AbortError")
      )
    }
    await this.operation?.catch(() => undefined)
    await this.active?.index.close()
    this.active = undefined
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
      index = await (this.options.openIndex ?? openWikiIndex)({
        workspacePath: canonicalPath,
        databasePath: indexPath(this.options.userDataPath, canonicalPath),
      })
      await index.refresh()
      const summary: WorkspaceSummary = {
        id: workspaceId(canonicalPath),
        name: input.name,
        domain: input.domain.trim(),
        displayPath: canonicalPath,
        commitHash: wiki.commitHash,
      }
      const previous = this.active
      await previous?.index.close()
      this.active = { summary, workspacePath: canonicalPath, index }
      this.currentJob = undefined
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

  private async ingest(
    active: ActiveWorkspace,
    document: SelectedDocument,
    objective: string,
    signal: AbortSignal
  ): Promise<IngestPastedSourceResult> {
    try {
      this.updateCurrentJob({
        phase: "preparing",
        message: "Preparing the source",
      })
      const agent = await this.createAgent((event) =>
        this.updateCurrentJob(piProgress(event))
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
          this.updateCurrentJob({
            phase: "committing",
            message: "Committing the wiki changes",
            cancellable: false,
          }),
      })
      this.updateCurrentJob({
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

  private updateCurrentJob(
    update: Partial<Pick<WikiIngestJob, "phase" | "message" | "cancellable">>
  ): void {
    if (!this.currentJob || this.currentJob.status !== "running") return
    this.currentJob = {
      ...this.currentJob,
      ...update,
      updatedAt: this.now().toISOString(),
      revision: this.currentJob.revision + 1,
    }
    this.emitCurrentJob()
  }

  private completeIngest(
    jobId: string,
    result: IngestPastedSourceResult
  ): void {
    if (!this.currentJob || this.currentJob.id !== jobId) return
    if (this.active) {
      this.active = {
        ...this.active,
        summary: { ...this.active.summary, commitHash: result.commitHash },
      }
    }
    this.currentJob = {
      ...this.currentJob,
      status: "completed",
      message:
        result.index.status === "ready"
          ? "The source is ready to search"
          : "The source was saved, but indexing needs to be retried",
      updatedAt: this.now().toISOString(),
      revision: this.currentJob.revision + 1,
      cancellable: false,
      result,
    }
    this.emitCurrentJob()
  }

  private failIngest(jobId: string, error: unknown): void {
    if (!this.currentJob || this.currentJob.id !== jobId) return
    const amendError = toAmendError(error)
    this.currentJob = {
      ...this.currentJob,
      status: amendError.code === "cancelled" ? "cancelled" : "failed",
      message: amendError.message,
      updatedAt: this.now().toISOString(),
      revision: this.currentJob.revision + 1,
      cancellable: false,
      error: amendError,
    }
    this.emitCurrentJob()
  }

  private emitCurrentJob(): void {
    if (!this.currentJob) return
    for (const listener of this.jobListeners) {
      try {
        listener(this.currentJob)
      } catch {
        // Renderer delivery must not affect the main-owned job.
      }
    }
  }

  private nextJobId(): string {
    const candidate = jobIdFrom(this.createId())
    return candidate === this.currentJob?.id
      ? jobIdFrom(randomUUID())
      : candidate
  }
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

function indexPath(userDataPath: string, workspacePath: string): string {
  return join(
    userDataPath,
    "indexes",
    `${createHash("sha256").update(workspacePath).digest("hex")}.sqlite`
  )
}

function workspaceId(workspacePath: string): string {
  return createHash("sha256").update(workspacePath).digest("hex").slice(0, 24)
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
