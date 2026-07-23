import { randomUUID } from "node:crypto"
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises"
import { basename, extname, join, relative, resolve } from "node:path"

import { isReadWikiFileInput } from "@workspace/contract"
import type {
  AmendError,
  AmendErrorCode,
  CancelIngestInput,
  ContinueWikiUpdateInput,
  CreateWikiInput,
  DeleteWikiInput,
  IngestDocumentInput,
  IngestPastedSourceResult,
  RenameWikiInput,
  ReadWikiFileInput,
  ReadWikiUpdateDiffInput,
  SourceDocumentSelection,
  StartIngestResult,
  StartWikiUpdateInput,
  StartWikiUpdateResult,
  WikiFileContent,
  WikiFileTreeItem,
  WikiIngestChangedEvent,
  WikiIngestJob,
  WikiIndexRefreshSummary,
  WikiProgressEvent,
  WikiSearchInput,
  WikiSearchResult,
  WikiTagFacet,
  WikiListItem,
  WikiSummary,
  WikiUpdateActivity,
  WikiUpdateApplyResult,
  WikiUpdateChangedEvent,
  WikiUpdateMessage,
  WikiUpdateSession,
  WikiUpdateSessionInput,
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
  createWikiUpdateProposalSession,
  WikiUpdateAgentError,
  WikiUpdateConflictError,
  WikiUpdateValidationError,
} from "@workspace/wiki-engine/update"
import type {
  WikiUpdateAgentEvent,
  WikiUpdateAgentSession,
  WikiUpdateProposalSession,
} from "@workspace/wiki-engine/update"
import { readWiki } from "@workspace/wiki-engine/wiki"
import type { Wiki } from "@workspace/wiki-engine/wiki"

import { WikiHome } from "./wiki-home.ts"

interface ActiveWiki {
  summary: WikiSummary
  wikiPath: string
  index: WikiIndex
}

interface SelectedDocument {
  ownerId: number
  path: string
  displayName: string
  title: string
  extension: string
}

interface RunningIngest {
  workspaceId: string
  jobId: string
  controller: AbortController
}

interface ActiveUpdate {
  snapshot: WikiUpdateSession
  proposal: WikiUpdateProposalSession
  controller?: AbortController
  emitTimer?: NodeJS.Timeout
}

interface WikiServiceOptions {
  userDataPath: string
  skillPath: string
  createId?: () => string
  now?: () => Date
  createAgent?: (
    onProgress: (event: PiProgressEvent) => void
  ) => Promise<WikiAgent>
  createEngine?: (agent: WikiAgent) => WikiEngine
  createUpdateAgent?: () => Promise<WikiUpdateAgentSession>
  createUpdateProposal?: (options: {
    workspacePath: string
    agent: WikiUpdateAgentSession
    createRunId: () => string
    now: () => Date
  }) => Promise<WikiUpdateProposalSession>
  openIndex?: (options: {
    workspacePath: string
    databasePath: string
  }) => Promise<WikiIndex>
  readWiki?: (input: { wikiPath: string }) => Promise<Wiki>
  moveToTrash?: (wikiPath: string) => Promise<void>
}

export class WikiServiceError extends Error {
  readonly code: AmendErrorCode

  constructor(code: AmendErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "WikiServiceError"
    this.code = code
  }
}

export class WikiService {
  private readonly options: WikiServiceOptions
  private readonly createId: () => string
  private readonly now: () => Date
  private readonly home: WikiHome
  private readonly documents = new Map<string, SelectedDocument>()
  private readonly contexts = new Map<string, ActiveWiki>()
  private readonly jobs = new Map<string, WikiIngestJob>()
  private readonly jobListeners = new Set<
    (event: WikiIngestChangedEvent) => void
  >()
  private readonly updates = new Map<string, ActiveUpdate>()
  private readonly updateListeners = new Set<
    (event: WikiUpdateChangedEvent) => void
  >()
  private active: ActiveWiki | undefined
  private lifecycleOperation: Promise<unknown> | undefined
  private modelOperation: Promise<unknown> | undefined
  private modelOperationStarting = false
  private pendingUpdateWikiId: string | undefined
  private runningIngest: RunningIngest | undefined
  private disposed = false

  constructor(options: WikiServiceOptions) {
    this.options = options
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.home = new WikiHome({ userDataPath: options.userDataPath })
  }

  subscribeIngestChanged(
    listener: (event: WikiIngestChangedEvent) => void
  ): () => void {
    this.jobListeners.add(listener)
    return () => this.jobListeners.delete(listener)
  }

  subscribeUpdateChanged(
    listener: (event: WikiUpdateChangedEvent) => void
  ): () => void {
    this.updateListeners.add(listener)
    return () => this.updateListeners.delete(listener)
  }

  async setWikiHome(parentPath: string): Promise<void> {
    this.assertOpen()
    const canonicalParent = await realpath(resolve(parentPath)).catch(
      (error) => {
        throw new WikiServiceError(
          "invalid-location",
          "The selected Amend home is not available.",
          { cause: error }
        )
      }
    )
    await mkdir(join(canonicalParent, ".amend"), { recursive: true })
    await this.home.setParentPath(canonicalParent)
  }

  async getWikiHome(): Promise<{ displayPath: string } | null> {
    this.assertOpen()
    const home = await this.home.read()
    return home ? { displayPath: home.parentPath } : null
  }

  async createWiki(input: CreateWikiInput): Promise<WikiSummary> {
    this.assertOpen()
    if (this.lifecycleOperation) {
      throw new WikiServiceError("busy", "Amend is already working.")
    }
    const operation = Promise.resolve().then(async () => {
      const home = await this.home.read()
      if (!home) {
        throw new WikiServiceError(
          "invalid-location",
          "Choose an Amend home before creating a wiki."
        )
      }
      const wikiPath = join(home.wikiDirectory, input.name)
      await assertTargetDoesNotExist(wikiPath)
      return await this.initializeWiki(wikiPath, input)
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
    const path = await realpath(resolve(documentPath)).catch((error) => {
      throw new WikiServiceError(
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
      throw new WikiServiceError(
        "invalid-input",
        "Choose a PDF, Markdown, or text document."
      )
    }
    if (metadata.size > 25_000_000) {
      throw new WikiServiceError(
        "invalid-input",
        "The document must be no larger than 25 MB."
      )
    }

    for (const [token, document] of this.documents) {
      if (document.ownerId === ownerId) this.documents.delete(token)
    }
    const displayName = basename(path)
    const title = displayName.slice(0, -extension.length).trim() || "Document"
    const token = `document_${this.createId().replace(/[^a-zA-Z0-9_-]/g, "")}`
    this.documents.set(token, {
      ownerId,
      path,
      displayName,
      title,
      extension,
    })
    return { token, displayName, suggestedTitle: title }
  }

  getCurrentWiki(): WikiSummary | null {
    this.assertOpen()
    return this.active?.summary ?? null
  }

  async listWikis(): Promise<readonly WikiListItem[]> {
    this.assertOpen()
    const wikis = await this.discoverWikis()
    return wikis.map((wiki) => ({
      id: wiki.id,
      name: basename(wiki.path),
      displayPath: wiki.path,
      active: this.active?.summary.id === wiki.id,
      running:
        this.jobs.get(wiki.id)?.status === "running" ||
        this.updates.get(wiki.id)?.snapshot.status === "running" ||
        false,
    }))
  }

  async renameWiki(input: RenameWikiInput): Promise<WikiSummary> {
    this.assertOpen()
    if (this.lifecycleOperation) {
      throw new WikiServiceError("busy", "Amend is already working.")
    }
    const operation = Promise.resolve().then(async () => {
      const home = await this.home.read()
      if (!home) {
        throw new WikiServiceError(
          "invalid-location",
          "Choose an Amend home before renaming a wiki."
        )
      }
      const record = (await this.discoverWikis()).find(
        ({ id }) => id === input.wikiId
      )
      if (!record) {
        throw new WikiServiceError("invalid-input", "The wiki was not found.")
      }
      if (this.jobs.get(input.wikiId)?.status === "running") {
        throw new WikiServiceError(
          "busy",
          "Wait for the wiki ingest to finish before renaming it."
        )
      }
      if (this.updates.has(input.wikiId)) {
        throw new WikiServiceError(
          "busy",
          "Finish or discard the wiki update before renaming it."
        )
      }

      const sourcePath = record.path
      if (basename(sourcePath) === input.name) {
        const existing = this.contexts.get(input.wikiId)
        if (existing) return existing.summary
        const context = await this.openWikiContext(sourcePath, input.wikiId)
        await this.storeWikiContext(context, false)
        return context.summary
      }

      const targetPath = join(home.wikiDirectory, input.name)
      await assertRenameTargetAvailable(sourcePath, targetPath)
      const wasActive = this.active?.summary.id === input.wikiId
      try {
        await rename(sourcePath, targetPath)
      } catch (error) {
        throw new WikiServiceError(
          "invalid-location",
          "The wiki folder could not be renamed.",
          { cause: error }
        )
      }

      let renamedContext: ActiveWiki | undefined
      try {
        const canonicalTarget = await realpath(targetPath)
        renamedContext = await this.openWikiContext(
          canonicalTarget,
          input.wikiId
        )
        await this.storeWikiContext(renamedContext, wasActive)
        return renamedContext.summary
      } catch (error) {
        if (
          renamedContext &&
          this.contexts.get(input.wikiId) !== renamedContext
        ) {
          await renamedContext.index.close().catch(() => undefined)
        }
        let recoveryError: unknown
        try {
          await rename(targetPath, sourcePath)
          const restored = await this.openWikiContext(sourcePath, input.wikiId)
          await this.storeWikiContext(restored, wasActive)
        } catch (cause) {
          recoveryError = cause
        }
        if (recoveryError) {
          throw new WikiServiceError(
            "wiki-open-failed",
            "The wiki was renamed, but it could not be reopened or restored.",
            { cause: recoveryError }
          )
        }
        throw new WikiServiceError(
          "wiki-open-failed",
          "The wiki could not be reopened, so its original name was restored.",
          { cause: error }
        )
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

  async deleteWiki(input: DeleteWikiInput): Promise<WikiSummary | null> {
    this.assertOpen()
    if (this.lifecycleOperation) {
      throw new WikiServiceError("busy", "Amend is already working.")
    }
    const operation = Promise.resolve().then(async () => {
      const home = await this.home.read()
      if (!home) {
        throw new WikiServiceError(
          "invalid-location",
          "Choose an Amend home before deleting a wiki."
        )
      }
      const record = (await this.discoverWikis()).find(
        ({ id }) => id === input.wikiId
      )
      if (!record) {
        throw new WikiServiceError("invalid-input", "The wiki was not found.")
      }
      if (!isPathInside(home.wikiDirectory, record.path)) {
        throw new WikiServiceError(
          "invalid-location",
          "The wiki is outside the Amend home."
        )
      }
      if (this.jobs.get(input.wikiId)?.status === "running") {
        throw new WikiServiceError(
          "busy",
          "Wait for the wiki ingest to finish before deleting it."
        )
      }
      if (this.updates.has(input.wikiId)) {
        throw new WikiServiceError(
          "busy",
          "Finish or discard the wiki update before deleting it."
        )
      }
      if (this.pendingUpdateWikiId === input.wikiId) {
        throw new WikiServiceError(
          "busy",
          "Wait for the wiki update to finish starting before deleting it."
        )
      }
      const moveToTrash = this.options.moveToTrash
      if (!moveToTrash) {
        throw new WikiServiceError(
          "operation-failed",
          "Moving a wiki to Trash is unavailable."
        )
      }

      const wasActive = this.active?.summary.id === input.wikiId
      try {
        await moveToTrash(record.path)
      } catch (error) {
        throw new WikiServiceError(
          "operation-failed",
          "The wiki could not be moved to Trash.",
          { cause: error }
        )
      }

      const context = this.contexts.get(input.wikiId)
      if (context) await this.closeWikiContext(input.wikiId, context)
      this.jobs.delete(input.wikiId)
      this.updates.delete(input.wikiId)
      await this.removeWikiIndex(input.wikiId)

      if (!wasActive) return this.active?.summary ?? null
      try {
        const next = (await this.discoverWikis()).at(0)
        if (next) return await this.openAndActivateWiki(next.path, next.id)
      } catch (error) {
        console.error(
          "[amend] failed to open a wiki after moving one to Trash:",
          error
        )
      }
      this.active = undefined
      await this.home.setLastActiveWikiId(null).catch((error: unknown) => {
        console.error(
          "[amend] failed to clear the deleted last-active wiki:",
          error
        )
      })
      return null
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

  async activateWiki(wikiId: string): Promise<WikiSummary> {
    this.assertOpen()
    if (this.lifecycleOperation) {
      throw new WikiServiceError("busy", "Amend is already working.")
    }
    const operation = Promise.resolve().then(async () => {
      const record = (await this.discoverWikis()).find(
        ({ id }) => id === wikiId
      )
      if (!record) {
        throw new WikiServiceError("invalid-input", "The wiki was not found.")
      }
      return await this.openAndActivateWiki(record.path, record.id)
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

  async openWiki(wikiPath: string): Promise<WikiSummary> {
    this.assertOpen()
    if (this.lifecycleOperation) {
      throw new WikiServiceError("busy", "Amend is already working.")
    }
    const operation = Promise.resolve().then(() =>
      this.openAndActivateWiki(wikiPath)
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

  async restoreLastActiveWiki(): Promise<WikiSummary | null> {
    this.assertOpen()
    if (this.lifecycleOperation) {
      throw new WikiServiceError("busy", "Amend is already working.")
    }
    const operation = Promise.resolve().then(async () => {
      const home = await this.home.read()
      if (!home?.lastActiveWikiId) return null
      const record = (await this.discoverWikis()).find(
        ({ id }) => id === home.lastActiveWikiId
      )
      if (!record) {
        await this.home.setLastActiveWikiId(null)
        return null
      }

      try {
        return await this.openAndActivateWiki(record.path, record.id)
      } catch (error) {
        console.error("[amend] failed to restore the last wiki:", error)
        await this.home.setLastActiveWikiId(null)
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
    if (this.lifecycleOperation) {
      throw new WikiServiceError("busy", "Amend is already working.")
    }
    const active = this.requireActive()
    if (this.modelOperation || this.modelOperationStarting) {
      throw new WikiServiceError("busy", "Amend is already working.")
    }
    const document = this.documents.get(input.documentToken)
    if (!document || document.ownerId !== ownerId) {
      throw new WikiServiceError(
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
      throw new WikiServiceError(
        "invalid-input",
        "The ingest job was not found."
      )
    }
    const [workspaceId, job] = entry
    if (job.status !== "running") return
    if (!job.cancellable) {
      throw new WikiServiceError(
        "operation-failed",
        "The ingest can no longer be cancelled because its commit has started."
      )
    }
    if (
      this.runningIngest?.workspaceId !== workspaceId ||
      this.runningIngest.jobId !== input.jobId
    ) {
      throw new WikiServiceError(
        "invalid-input",
        "The ingest job was not found."
      )
    }
    this.runningIngest.controller.abort(
      new DOMException("The ingest was cancelled", "AbortError")
    )
  }

  getCurrentUpdate(): WikiUpdateSession | null {
    this.assertOpen()
    const active = this.requireActive()
    return this.updates.get(active.summary.id)?.snapshot ?? null
  }

  async startUpdate(
    input: StartWikiUpdateInput
  ): Promise<StartWikiUpdateResult> {
    this.assertOpen()
    if (this.lifecycleOperation) {
      throw new WikiServiceError("busy", "Amend is already working.")
    }
    const active = this.requireActive()
    if (this.updates.has(active.summary.id)) {
      throw new WikiServiceError(
        "busy",
        "This wiki already has an update session."
      )
    }
    if (this.modelOperation || this.modelOperationStarting) {
      throw new WikiServiceError("busy", "Amend is already working.")
    }
    this.modelOperationStarting = true
    this.pendingUpdateWikiId = active.summary.id
    let agent: WikiUpdateAgentSession | undefined
    const setupOperation = Promise.resolve().then(async () => {
      agent = await this.createUpdateAgent()
      return await (
        this.options.createUpdateProposal ?? createWikiUpdateProposalSession
      )({
        workspacePath: active.wikiPath,
        agent,
        createRunId: this.createId,
        now: this.now,
      })
    })
    this.modelOperation = setupOperation
    let proposal: WikiUpdateProposalSession
    try {
      proposal = await setupOperation
    } catch (error) {
      agent?.dispose()
      throw updateServiceError(error)
    } finally {
      if (this.modelOperation === setupOperation) {
        this.modelOperation = undefined
      }
      this.modelOperationStarting = false
      this.pendingUpdateWikiId = undefined
    }
    if (this.disposed) {
      await proposal.discard().catch(() => undefined)
      throw new WikiServiceError("cancelled", "Amend is shutting down.")
    }
    const sessionId = this.nextUpdateId()
    const timestamp = this.now().toISOString()
    this.updates.set(active.summary.id, {
      proposal,
      snapshot: {
        id: sessionId,
        wikiId: active.summary.id,
        baseCommit: proposal.baseCommit,
        status: "running",
        revision: 0,
        updatedAt: timestamp,
        cancellable: true,
        messages: [updateMessage("user", input.prompt, timestamp)],
        activity: [],
      },
    })
    this.emitUpdate(active.summary.id)
    this.startUpdateTurn(active.summary.id, input.prompt, input.contextPath)
    return { sessionId }
  }

  continueUpdate(input: ContinueWikiUpdateInput): void {
    this.assertOpen()
    const active = this.requireUpdate(input.sessionId)
    if (active.snapshot.status === "running") {
      throw new WikiServiceError("busy", "The update is still running.")
    }
    if (
      active.snapshot.status === "applying" ||
      this.modelOperation ||
      this.modelOperationStarting
    ) {
      throw new WikiServiceError("busy", "Amend is already working.")
    }
    const timestamp = this.now().toISOString()
    active.snapshot = {
      ...active.snapshot,
      status: "running",
      revision: active.snapshot.revision + 1,
      updatedAt: timestamp,
      cancellable: true,
      messages: [
        ...active.snapshot.messages,
        updateMessage("user", input.prompt, timestamp),
      ],
      activity: [],
      error: undefined,
    }
    this.emitUpdate(active.snapshot.wikiId)
    this.startUpdateTurn(active.snapshot.wikiId, input.prompt)
  }

  cancelUpdateTurn(input: WikiUpdateSessionInput): void {
    this.assertOpen()
    const update = this.requireUpdate(input.sessionId)
    if (update.snapshot.status !== "running" || !update.controller) return
    update.controller.abort(
      new DOMException("The wiki update was cancelled", "AbortError")
    )
  }

  async readUpdateDiff(
    input: ReadWikiUpdateDiffInput
  ): Promise<{ path: string; patch: string }> {
    this.assertOpen()
    const update = this.requireUpdate(input.sessionId)
    try {
      return {
        path: input.path,
        patch: await update.proposal.readDiff(input.path),
      }
    } catch (error) {
      throw updateServiceError(error)
    }
  }

  async applyUpdate(
    input: WikiUpdateSessionInput
  ): Promise<WikiUpdateApplyResult> {
    this.assertOpen()
    const update = this.requireUpdate(input.sessionId)
    if (update.snapshot.status !== "review" || !update.snapshot.proposal) {
      throw new WikiServiceError(
        "invalid-input",
        "The update has no reviewed changes to apply."
      )
    }
    if (this.modelOperation || this.modelOperationStarting) {
      throw new WikiServiceError("busy", "Amend is already working.")
    }
    const workspaceId = update.snapshot.wikiId
    update.snapshot = {
      ...update.snapshot,
      status: "applying",
      revision: update.snapshot.revision + 1,
      updatedAt: this.now().toISOString(),
      cancellable: false,
      error: undefined,
    }
    this.emitUpdate(workspaceId)
    const operation = update.proposal.apply()
    this.modelOperation = operation
    try {
      const commit = await operation
      const context = this.contexts.get(workspaceId)
      const index: WikiUpdateApplyResult["index"] = context
        ? await context.index.refresh().then(
            (summary) => ({ status: "ready" as const, summary }),
            () => ({
              status: "failed" as const,
              error: {
                code: "index-failed" as const,
                message:
                  "The update was saved, but the search index could not be refreshed.",
              },
            })
          )
        : {
            status: "failed",
            error: {
              code: "index-failed",
              message:
                "The update was saved, but the wiki is no longer open for indexing.",
            },
          }
      if (context) {
        const nextContext: ActiveWiki = {
          ...context,
          summary: { ...context.summary, commitHash: commit.commitHash },
        }
        this.contexts.set(workspaceId, nextContext)
        if (this.active?.summary.id === workspaceId) this.active = nextContext
      }
      const result: WikiUpdateApplyResult = {
        runId: commit.runId,
        commitHash: commit.commitHash,
        changedFiles: commit.changedFiles,
        summary: commit.summary,
        ...(update.snapshot.usage ? { usage: update.snapshot.usage } : {}),
        index,
      }
      this.updates.delete(workspaceId)
      this.emitUpdate(workspaceId, null)
      return result
    } catch (error) {
      update.snapshot = {
        ...update.snapshot,
        status: "review",
        revision: update.snapshot.revision + 1,
        updatedAt: this.now().toISOString(),
        cancellable: false,
        error: toUpdateError(error),
      }
      this.emitUpdate(workspaceId)
      throw updateServiceError(error)
    } finally {
      if (this.modelOperation === operation) this.modelOperation = undefined
    }
  }

  async discardUpdate(input: WikiUpdateSessionInput): Promise<void> {
    this.assertOpen()
    const update = this.requireUpdate(input.sessionId)
    if (
      update.snapshot.status === "running" ||
      update.snapshot.status === "applying"
    ) {
      throw new WikiServiceError(
        "busy",
        "Cancel the current update operation before discarding it."
      )
    }
    await update.proposal.discard().catch((error: unknown) => {
      throw updateServiceError(error)
    })
    this.updates.delete(update.snapshot.wikiId)
    this.emitUpdate(update.snapshot.wikiId, null)
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
      return await listWorkspaceFiles(active.wikiPath)
    } catch (error) {
      throw new WikiServiceError(
        "operation-failed",
        "Wiki files could not be loaded.",
        { cause: error }
      )
    }
  }

  async readFile(input: ReadWikiFileInput): Promise<WikiFileContent> {
    this.assertOpen()
    const active = this.requireActive()
    if (!isReadWikiFileInput(input)) {
      throw new WikiServiceError("invalid-input", "Choose a wiki file.")
    }
    const { absolutePath, relativePath } = workspaceFilePath(
      active.wikiPath,
      input.path
    )
    const metadata = await lstat(absolutePath).catch((error) => {
      throw new WikiServiceError(
        "invalid-input",
        "The selected wiki file is not available.",
        { cause: error }
      )
    })
    if (!metadata.isFile()) {
      throw new WikiServiceError("invalid-input", "Choose a wiki file.")
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
      throw new WikiServiceError(
        "invalid-input",
        "The selected text file is too large to preview."
      )
    }
    const content = (await readFile(absolutePath)).toString("utf8")
    if (content.includes("\0")) {
      throw new WikiServiceError(
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
    if (this.modelOperation || this.modelOperationStarting) {
      throw new WikiServiceError("busy", "Amend is already working.")
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
    for (const update of this.updates.values()) {
      if (update.emitTimer) clearTimeout(update.emitTimer)
      update.controller?.abort(
        new DOMException("Amend is shutting down", "AbortError")
      )
    }
    await Promise.all([
      this.lifecycleOperation?.catch(() => undefined),
      this.modelOperation?.catch(() => undefined),
    ])
    await Promise.all(
      [...this.updates.values()].map(async (update) => {
        await update.proposal.discard().catch(() => undefined)
      })
    )
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
    this.updates.clear()
    this.documents.clear()
    this.jobListeners.clear()
    this.updateListeners.clear()
  }

  private async initializeWiki(
    workspacePath: string,
    input: CreateWikiInput
  ): Promise<WikiSummary> {
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
      const summary: WikiSummary = {
        id: wiki.id,
        name: input.name,
        domain: input.domain.trim(),
        displayPath: canonicalPath,
        commitHash: wiki.commitHash,
        setupStatus: "initialized",
      }
      await this.setActiveWiki({
        summary,
        wikiPath: canonicalPath,
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
        throw new WikiServiceError(
          "git-unavailable",
          "Git is required to create an Amend wiki.",
          { cause: error }
        )
      }
      if (error instanceof WikiServiceError) throw error
      throw new WikiServiceError(
        "wiki-creation-failed",
        "The wiki could not be created.",
        { cause: error }
      )
    }
  }

  private async openAndActivateWiki(
    wikiPath: string,
    expectedId?: string
  ): Promise<WikiSummary> {
    const context = await this.openWikiContext(wikiPath, expectedId)
    await this.setActiveWiki(context)
    return context.summary
  }

  private async openWikiContext(
    wikiPath: string,
    expectedId?: string
  ): Promise<ActiveWiki> {
    let index: WikiIndex | undefined
    try {
      const canonicalPath = await realpath(resolve(wikiPath))
      const wiki = await (this.options.readWiki ?? readWiki)({
        wikiPath: canonicalPath,
      })
      if (expectedId !== undefined && wiki.id !== expectedId) {
        throw new Error("The wiki ID does not match the catalog record")
      }
      const existing = this.contexts.get(wiki.id)
      if (existing?.wikiPath === canonicalPath) {
        return existing
      }
      index = await this.openWorkspaceIndex(canonicalPath, wiki.id, existing)
      const refresh = await index.refresh()
      const summary: WikiSummary = {
        id: wiki.id,
        name: basename(canonicalPath) || canonicalPath,
        domain: wiki.domain,
        displayPath: canonicalPath,
        commitHash: refresh.commitHash,
        setupStatus: wiki.setupStatus,
      }
      return {
        summary,
        wikiPath: canonicalPath,
        index,
      }
    } catch (error) {
      await index?.close().catch(() => undefined)
      if (error instanceof WikiServiceError) throw error
      if (isGitUnavailable(error)) {
        throw new WikiServiceError(
          "git-unavailable",
          "Git is required to open an Amend wiki.",
          { cause: error }
        )
      }
      throw new WikiServiceError(
        "wiki-open-failed",
        "The wiki could not be opened.",
        { cause: error }
      )
    }
  }

  private async storeWikiContext(
    candidate: ActiveWiki,
    makeActive: boolean
  ): Promise<void> {
    if (makeActive) {
      await this.setActiveWiki(candidate)
      return
    }
    const replaced = this.contexts.get(candidate.summary.id)
    this.contexts.set(candidate.summary.id, candidate)
    if (replaced && replaced !== candidate) {
      await replaced.index.close().catch((error: unknown) => {
        console.error("[amend] failed to close a replaced wiki index:", error)
      })
    }
  }

  private async discoverWikis(): Promise<
    readonly { id: string; path: string }[]
  > {
    const home = await this.home.read()
    if (!home) return []
    let entries
    try {
      entries = await readdir(home.wikiDirectory, { withFileTypes: true })
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return []
      throw error
    }
    const wikis = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name !== ".amend")
        .map(async (entry) => {
          const path = await realpath(join(home.wikiDirectory, entry.name))
          if (!isPathInside(home.wikiDirectory, path)) return null
          try {
            const wiki = await (this.options.readWiki ?? readWiki)({
              wikiPath: path,
            })
            return { id: wiki.id, path }
          } catch {
            return null
          }
        })
    )
    const discovered = wikis.filter(
      (wiki): wiki is { id: string; path: string } => Boolean(wiki)
    )
    for (const context of this.contexts.values()) {
      if (!isPathInside(home.wikiDirectory, context.wikiPath)) continue
      if (!discovered.some(({ id }) => id === context.summary.id)) {
        discovered.push({ id: context.summary.id, path: context.wikiPath })
      }
    }
    return discovered.sort((left, right) => left.path.localeCompare(right.path))
  }

  private async setActiveWiki(candidate: ActiveWiki): Promise<void> {
    await this.home.setLastActiveWikiId(candidate.summary.id)

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
    replaced?: ActiveWiki
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
      if (replaced) await this.closeWikiContext(workspaceId, replaced)
      await Promise.all(
        [databasePath, `${databasePath}-shm`, `${databasePath}-wal`].map(
          (path) => rm(path, { force: true })
        )
      )
      return await open({ workspacePath, databasePath })
    }
  }

  private async closeWikiContext(
    workspaceId: string,
    context: ActiveWiki
  ): Promise<void> {
    if (this.contexts.get(workspaceId) === context) {
      this.contexts.delete(workspaceId)
    }
    if (this.active === context) this.active = undefined
    await context.index.close().catch((error: unknown) => {
      console.error("[amend] failed to close a replaced wiki index:", error)
    })
  }

  private async removeWikiIndex(wikiId: string): Promise<void> {
    const databasePath = indexPath(this.options.userDataPath, wikiId)
    await Promise.all(
      [databasePath, `${databasePath}-shm`, `${databasePath}-wal`].map((path) =>
        rm(path, { force: true })
      )
    ).catch((error: unknown) => {
      console.error("[amend] failed to remove a deleted wiki index:", error)
    })
  }

  private async ingest(
    active: ActiveWiki,
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
        throw new WikiServiceError(
          "invalid-input",
          "The extracted document text must be no larger than 5 MB."
        )
      }
      const sourceDirectory =
        document.extension === ".pdf" ? "papers" : "articles"
      const sourcePath = `raw/${sourceDirectory}/${sourceSlug(document.title, this.createId())}.md`
      const run = await engine.ingest({
        workspacePath: active.wikiPath,
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
        throw new WikiServiceError("cancelled", "The ingest was cancelled.", {
          cause: error,
        })
      }
      if (error instanceof WikiServiceError) throw error
      console.error("[amend] ingest failed:", error)
      if (isGitUnavailable(error)) {
        throw new WikiServiceError(
          "git-unavailable",
          "Git is required to integrate a source into the wiki.",
          { cause: error }
        )
      }
      throw new WikiServiceError("ingest-failed", ingestFailureMessage(error), {
        cause: error,
      })
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
      throw new WikiServiceError(
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

  private async createUpdateAgent(): Promise<WikiUpdateAgentSession> {
    if (this.options.createUpdateAgent) {
      return await this.options.createUpdateAgent()
    }
    let settings: PiAgentSettings
    const { createPiWikiUpdateAgentSession, readPiAgentSettings } =
      await import("@workspace/wiki-engine/agent/pi")
    try {
      settings = await readPiAgentSettings()
    } catch (error) {
      throw new WikiServiceError(
        "pi-configuration-missing",
        "Configure a default Pi provider and model before updating the wiki.",
        { cause: error }
      )
    }
    return createPiWikiUpdateAgentSession({
      ...settings,
      skillPath: this.options.skillPath,
    })
  }

  private startUpdateTurn(
    workspaceId: string,
    prompt: string,
    contextPath?: string
  ): void {
    const update = this.updates.get(workspaceId)
    if (!update) return
    const controller = new AbortController()
    update.controller = controller
    const assistant = updateMessage("assistant", "", this.now().toISOString())
    assistant.status = "streaming"
    update.snapshot = {
      ...update.snapshot,
      messages: [...update.snapshot.messages, assistant],
    }
    const operation = update.proposal.runTurn({
      prompt,
      contextPath,
      signal: controller.signal,
      onEvent: (event) =>
        this.projectUpdateAgentEvent(workspaceId, assistant.id, event),
    })
    this.modelOperation = operation
    void operation
      .then(
        (result) => {
          const current = this.updates.get(workspaceId)
          if (!current || current.snapshot.id !== update.snapshot.id) return
          const messages = current.snapshot.messages.map((message) =>
            message.id === assistant.id
              ? {
                  ...message,
                  content: message.content || result.output,
                  status: "complete" as const,
                }
              : message
          )
          current.snapshot = {
            ...current.snapshot,
            status: "review",
            revision: current.snapshot.revision + 1,
            updatedAt: this.now().toISOString(),
            cancellable: false,
            messages,
            proposal:
              result.changedFiles.length > 0
                ? {
                    summary: result.summary,
                    changedFiles: result.changedFiles,
                  }
                : undefined,
            error: undefined,
            ...(result.usage ? { usage: result.usage } : {}),
          }
          this.flushUpdateEvent(workspaceId)
        },
        (error: unknown) => {
          const current = this.updates.get(workspaceId)
          if (!current || current.snapshot.id !== update.snapshot.id) return
          const amendError = toUpdateError(error)
          const messages = current.snapshot.messages.map((message) =>
            message.id === assistant.id
              ? { ...message, status: "complete" as const }
              : message
          )
          current.snapshot = {
            ...current.snapshot,
            status: current.snapshot.proposal ? "review" : "failed",
            revision: current.snapshot.revision + 1,
            updatedAt: this.now().toISOString(),
            cancellable: false,
            messages,
            error: amendError,
          }
          this.flushUpdateEvent(workspaceId)
        }
      )
      .finally(() => {
        const current = this.updates.get(workspaceId)
        if (current?.snapshot.id === update.snapshot.id) {
          current.controller = undefined
        }
        if (this.modelOperation === operation) this.modelOperation = undefined
      })
  }

  private projectUpdateAgentEvent(
    workspaceId: string,
    assistantMessageId: string,
    event: WikiUpdateAgentEvent
  ) {
    const update = this.updates.get(workspaceId)
    if (!update || update.snapshot.status !== "running") return
    if (event.type === "assistant-delta") {
      update.snapshot = {
        ...update.snapshot,
        revision: update.snapshot.revision + 1,
        updatedAt: this.now().toISOString(),
        messages: update.snapshot.messages.map((message) =>
          message.id === assistantMessageId
            ? { ...message, content: `${message.content}${event.text}` }
            : message
        ),
      }
      this.scheduleUpdateEvent(workspaceId)
      return
    }
    if (event.type === "repair") {
      const activity = updateActivity(
        `activity_${randomUUID().replaceAll("-", "")}`,
        "repair",
        "Repairing wiki validation issues",
        "running"
      )
      update.snapshot = appendUpdateActivity(
        update.snapshot,
        activity,
        this.now()
      )
      this.emitUpdate(workspaceId)
      return
    }
    if (event.type === "validation") {
      const existing = update.snapshot.activity.find(
        ({ id }) => id === "update_validation"
      )
      const activity = updateActivity(
        "update_validation",
        "validate",
        "Validated wiki changes",
        event.status
      )
      update.snapshot = existing
        ? {
            ...update.snapshot,
            revision: update.snapshot.revision + 1,
            updatedAt: this.now().toISOString(),
            activity: update.snapshot.activity.map((item) =>
              item.id === activity.id ? activity : item
            ),
          }
        : appendUpdateActivity(update.snapshot, activity, this.now())
      this.emitUpdate(workspaceId)
      return
    }
    if (event.type === "tool-start") {
      const tool = updateToolName(event.toolName)
      const activity = updateActivity(
        event.callId,
        tool,
        updateToolLabel(tool, event.input),
        "running"
      )
      update.snapshot = appendUpdateActivity(
        update.snapshot,
        activity,
        this.now()
      )
      this.emitUpdate(workspaceId)
      return
    }
    update.snapshot = {
      ...update.snapshot,
      revision: update.snapshot.revision + 1,
      updatedAt: this.now().toISOString(),
      activity: update.snapshot.activity.map((activity) =>
        activity.id === event.callId
          ? {
              ...activity,
              status: event.isError ? "failed" : "complete",
            }
          : activity
      ),
    }
    this.emitUpdate(workspaceId)
  }

  private scheduleUpdateEvent(workspaceId: string) {
    const update = this.updates.get(workspaceId)
    if (!update || update.emitTimer) return
    update.emitTimer = setTimeout(() => {
      update.emitTimer = undefined
      this.emitUpdate(workspaceId)
    }, 50)
    update.emitTimer.unref()
  }

  private flushUpdateEvent(workspaceId: string) {
    const update = this.updates.get(workspaceId)
    if (update?.emitTimer) {
      clearTimeout(update.emitTimer)
      update.emitTimer = undefined
    }
    this.emitUpdate(workspaceId)
  }

  private requireUpdate(sessionId: string): ActiveUpdate {
    const update = [...this.updates.values()].find(
      ({ snapshot }) => snapshot.id === sessionId
    )
    if (!update) {
      throw new WikiServiceError(
        "invalid-input",
        "The wiki update session was not found."
      )
    }
    return update
  }

  private emitUpdate(workspaceId: string, session?: WikiUpdateSession | null) {
    const payload =
      session === undefined
        ? (this.updates.get(workspaceId)?.snapshot ?? null)
        : session
    for (const listener of this.updateListeners) {
      try {
        listener({ wikiId: workspaceId, session: payload })
      } catch {
        // Renderer delivery must not affect the main-owned update session.
      }
    }
  }

  private createEngine(agent: WikiAgent): WikiEngine {
    return this.options.createEngine?.(agent) ?? createWikiEngine({ agent })
  }

  private requireActive(): ActiveWiki {
    if (!this.active) {
      throw new WikiServiceError("no-active-wiki", "Create a wiki first.")
    }
    return this.active
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new WikiServiceError("cancelled", "Amend is shutting down.")
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
      const updated: ActiveWiki = {
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
        listener({ wikiId: workspaceId, job })
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

  private nextUpdateId(): string {
    const candidate = `update_${this.createId().replace(/[^a-zA-Z0-9_-]/g, "")}`
    return [...this.updates.values()].some(
      ({ snapshot }) => snapshot.id === candidate
    )
      ? `update_${randomUUID().replaceAll("-", "")}`
      : candidate
  }
}

function updateMessage(
  role: WikiUpdateMessage["role"],
  content: string,
  createdAt: string
): WikiUpdateMessage {
  return {
    id: `message_${randomUUID().replaceAll("-", "")}`,
    role,
    content,
    status: "complete",
    createdAt,
  }
}

function updateActivity(
  id: string,
  tool: WikiUpdateActivity["tool"],
  label: string,
  status: WikiUpdateActivity["status"]
): WikiUpdateActivity {
  return {
    id: id.length >= 8 ? id.replace(/[^a-zA-Z0-9_-]/g, "_") : `activity_${id}`,
    tool,
    label,
    status,
  }
}

function appendUpdateActivity(
  snapshot: WikiUpdateSession,
  activity: WikiUpdateActivity,
  now: Date
): WikiUpdateSession {
  return {
    ...snapshot,
    revision: snapshot.revision + 1,
    updatedAt: now.toISOString(),
    activity: [...snapshot.activity.slice(-49), activity],
  }
}

function updateToolName(value: string): WikiUpdateActivity["tool"] {
  return ["read", "grep", "find", "ls", "edit", "write"].includes(value)
    ? (value as WikiUpdateActivity["tool"])
    : "read"
}

function updateToolLabel(
  tool: WikiUpdateActivity["tool"],
  input: unknown
): string {
  const record =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {}
  const path =
    typeof record.path === "string" && record.path.trim()
      ? conciseActivityValue(record.path, ".")
      : "."
  switch (tool) {
    case "read":
      return `Read ${path}`
    case "edit":
      return `Edited ${path}`
    case "write":
      return `Wrote ${path}`
    case "grep":
      return `Searched for ${conciseActivityValue(record.pattern, "text")} in ${path}`
    case "find":
      return `Found ${conciseActivityValue(record.pattern, "files")} in ${path}`
    case "ls":
      return `Listed ${path}`
    case "validate":
      return "Validated wiki changes"
    case "repair":
      return "Repaired wiki validation issues"
  }
}

function conciseActivityValue(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : fallback
  const normalized = text.replace(/\s+/g, " ").trim() || fallback
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`
}

function toUpdateError(error: unknown): AmendError {
  if (error instanceof WikiServiceError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof WikiUpdateConflictError) {
    return { code: "update-conflict", message: error.message }
  }
  if (error instanceof WikiUpdateAgentError) {
    return { code: "pi-failed", message: error.message }
  }
  if (isAbortError(error)) {
    return { code: "cancelled", message: "The wiki update was cancelled." }
  }
  if (error instanceof WikiUpdateValidationError) {
    return {
      code: "update-failed",
      message: error.message,
    }
  }
  return {
    code: "update-failed",
    message: error instanceof Error ? error.message : "The wiki update failed.",
  }
}

function updateServiceError(error: unknown): WikiServiceError {
  const amendError = toUpdateError(error)
  return new WikiServiceError(amendError.code, amendError.message, {
    cause: error,
  })
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
    throw new WikiServiceError("invalid-input", "Choose a wiki file.")
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
    throw new WikiServiceError(
      "invalid-location",
      "The wiki location could not be checked.",
      { cause: error }
    )
  }
  throw new WikiServiceError(
    "invalid-location",
    "A file or folder already exists at that wiki location."
  )
}

async function assertRenameTargetAvailable(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  const sourceCanonicalPath = await realpath(sourcePath)
  try {
    const targetCanonicalPath = await realpath(targetPath)
    if (targetCanonicalPath === sourceCanonicalPath) return
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return
    throw new WikiServiceError(
      "invalid-location",
      "The wiki location could not be checked.",
      { cause: error }
    )
  }
  throw new WikiServiceError(
    "invalid-location",
    "A file or folder already exists at that wiki location."
  )
}

function indexPath(userDataPath: string, workspaceId: string): string {
  return join(userDataPath, "indexes", `${workspaceId}.sqlite`)
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(resolve(parentPath), candidatePath)
  return relativePath !== "" && !relativePath.startsWith("..")
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
      throw new WikiServiceError(
        "invalid-input",
        "The selected document is not valid UTF-8 text."
      )
    }
  }
  if (!text.trim()) {
    throw new WikiServiceError(
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
  if (error instanceof WikiServiceError) {
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
): WikiServiceError {
  return new WikiServiceError(
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
