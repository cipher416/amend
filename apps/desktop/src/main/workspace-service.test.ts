import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "vitest"

import { WikiIndexError } from "@workspace/wiki-engine/index"
import type { WikiIndex } from "@workspace/wiki-engine/index"
import type {
  WikiAgent,
  WikiEngine,
  WikiRunResult,
} from "@workspace/wiki-engine/ingest"

import type { WorkspaceCatalogRecord } from "./workspace-catalog.ts"
import { WorkspaceService, WorkspaceServiceError } from "./workspace-service.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("workspace service", () => {
  it("creates a workspace, ingests a generated source path, and refreshes", async () => {
    const parent = await temporaryDirectory()
    const calls: string[] = []
    const sourcePaths: string[] = []
    const index = createFakeIndex(calls)
    const catalog = createFakeCatalog()
    const ids = [
      "selection-id-1234567890",
      "document-id-1234567890",
      "job-id-1234567890",
      "source-id-1234567890",
    ]
    const service = new WorkspaceService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createId: () => ids.shift() ?? "fallback-id",
      createAgent: async () => createFakeAgent(),
      createEngine: () => createFakeEngine(calls, sourcePaths),
      catalog,
      openIndex: async ({ databasePath }) => {
        calls.push(`open-index:${databasePath}`)
        return index
      },
    })
    const jobs: string[] = []
    service.subscribeIngestChanged(({ job }) =>
      jobs.push(`${job.status}:${job.phase}`)
    )

    const documentPath = join(parent, "Write-ahead logging.md")
    await writeFile(
      documentPath,
      "A WAL records mutations before pages change."
    )
    const document = await service.registerSourceDocument(7, documentPath)
    const selection = await service.registerParentSelection(7, parent)
    const workspace = await service.createWorkspace(7, {
      selectionToken: selection.token,
      name: "Reliability Wiki",
      domain: "Database reliability",
    })
    const started = await service.startIngest(7, {
      documentToken: document.token,
      objective: "Capture the recovery ordering guarantees.",
    })
    const job = await waitForTerminalJob(service)

    assert.equal(workspace.name, "Reliability Wiki")
    assert.equal(workspace.id, "123e4567-e89b-42d3-a456-426614174003")
    assert.equal(workspace.setupStatus, "initialized")
    assert.equal(service.getCurrentWorkspace()?.id, workspace.id)
    assert.equal(started.jobId, "ingest_job-id-1234567890")
    assert.match(workspace.displayPath, /Reliability Wiki$/)
    assert.deepEqual(sourcePaths, [
      "raw/articles/write-ahead-logging-sourceid.md",
    ])
    assert.equal(job.result?.commitHash, "ingest-commit")
    assert.equal(job.result.index.status, "ready")
    assert.equal(job.result.index.summary.commitHash, "ingest-commit")
    assert.equal(service.getCurrentWorkspace()?.commitHash, "ingest-commit")
    assert.equal(service.getCurrentWorkspace()?.setupStatus, "ready")
    assert.ok(jobs.includes("running:preparing"))
    assert.ok(jobs.includes("running:indexing"))
    assert.equal(jobs.at(-1), "completed:indexing")
    assert.equal(calls[0], "initialize")
    assert.match(
      calls[1] ?? "",
      /indexes.*123e4567-e89b-42d3-a456-426614174003\.sqlite$/
    )
    assert.deepEqual(calls.slice(2), ["refresh", "ingest", "refresh"])
    assert.deepEqual(catalog.lastActive, {
      id: workspace.id,
      path: workspace.displayPath,
    })

    await service.dispose()
    assert.equal(calls.at(-1), "close")
  })

  it("binds location selections to the renderer that chose them", async () => {
    const parent = await temporaryDirectory()
    const service = new WorkspaceService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createId: () => "selection-id-1234567890",
    })
    const selection = await service.registerParentSelection(7, parent)

    await assert.rejects(
      service.createWorkspace(8, {
        selectionToken: selection.token,
        name: "Wiki",
        domain: "Research",
      }),
      (error: unknown) =>
        error instanceof WorkspaceServiceError &&
        error.code === "invalid-location"
    )
    await service.dispose()
  })

  it("reserves workspace creation before checking the target", async () => {
    const parent = await temporaryDirectory()
    let releaseInitialization: (() => void) | undefined
    const initializationBlocked = new Promise<void>((resolve) => {
      releaseInitialization = resolve
    })
    const service = new WorkspaceService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createId: () => "selection-id-1234567890",
      createEngine: () => ({
        async initialize({ workspacePath }) {
          await initializationBlocked
          await mkdir(workspacePath)
          return {
            workspacePath,
            id: "123e4567-e89b-42d3-a456-426614174001",
            commitHash: "initial-commit",
          }
        },
        async ingest() {
          return ingestResult()
        },
      }),
      openIndex: async () => createFakeIndex([]),
    })
    const selection = await service.registerParentSelection(7, parent)
    const first = service.createWorkspace(7, {
      selectionToken: selection.token,
      name: "Wiki",
      domain: "Research",
    })

    await assert.rejects(
      service.createWorkspace(7, {
        selectionToken: selection.token,
        name: "Another Wiki",
        domain: "Research",
      }),
      (error: unknown) =>
        error instanceof WorkspaceServiceError && error.code === "busy"
    )
    releaseInitialization?.()
    await first
    await service.dispose()
  })

  it("cancels an active ingest and keeps the initialized workspace", async () => {
    const parent = await temporaryDirectory()
    const index = createFakeIndex([])
    const service = new WorkspaceService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createId: () => "selection-id-1234567890",
      createAgent: async () => createFakeAgent(),
      createEngine: () => createCancellableEngine(),
      openIndex: async () => index,
    })
    const selection = await service.registerParentSelection(7, parent)
    await service.createWorkspace(7, {
      selectionToken: selection.token,
      name: "Wiki",
      domain: "Research",
    })

    const documentPath = join(parent, "Source.txt")
    await writeFile(documentPath, "Material")
    const document = await service.registerSourceDocument(7, documentPath)
    const started = await service.startIngest(7, {
      documentToken: document.token,
      objective: "Capture it",
    })
    assert.equal(service.getCurrentIngest()?.status, "running")
    service.cancelIngest({ jobId: started.jobId })

    const job = await waitForTerminalJob(service)
    assert.equal(job.status, "cancelled")
    assert.equal(job.error?.code, "cancelled")
    await assert.doesNotReject(service.search({ query: "still active" }))
    await service.dispose()
  })

  it("stops offering cancellation when commit promotion begins", async () => {
    const parent = await temporaryDirectory()
    let markCommitStarted: (() => void) | undefined
    let releaseCommit: (() => void) | undefined
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve
    })
    const commitBlocked = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    const service = new WorkspaceService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createId: () => "stable-id-1234567890",
      createAgent: async () => createFakeAgent(),
      createEngine: () => ({
        async initialize({ workspacePath }) {
          await mkdir(workspacePath)
          return {
            workspacePath,
            id: "123e4567-e89b-42d3-a456-426614174002",
            commitHash: "initial-commit",
          }
        },
        async ingest({ onCommitStart }) {
          onCommitStart?.()
          markCommitStarted?.()
          await commitBlocked
          return ingestResult()
        },
      }),
      openIndex: async () => createFakeIndex([]),
    })
    const selection = await service.registerParentSelection(7, parent)
    await service.createWorkspace(7, {
      selectionToken: selection.token,
      name: "Wiki",
      domain: "Research",
    })
    const documentPath = join(parent, "Source.md")
    await writeFile(documentPath, "Material")
    const document = await service.registerSourceDocument(7, documentPath)
    const started = await service.startIngest(7, {
      documentToken: document.token,
      objective: "Capture it",
    })

    await commitStarted
    assert.equal(service.getCurrentIngest()?.phase, "committing")
    assert.equal(service.getCurrentIngest()?.cancellable, false)
    assert.throws(
      () => service.cancelIngest({ jobId: started.jobId }),
      (error: unknown) =>
        error instanceof WorkspaceServiceError &&
        error.code === "operation-failed"
    )

    releaseCommit?.()
    assert.equal((await waitForTerminalJob(service)).status, "completed")
    await service.dispose()
  })

  it("lists and activates open workspaces without reopening their indexes", async () => {
    const parent = await temporaryDirectory()
    const firstPath = join(parent, "First Wiki")
    const secondPath = join(parent, "Second Wiki")
    await Promise.all([mkdir(firstPath), mkdir(secondPath)])
    const calls: string[] = []
    const catalog = createFakeCatalog()
    const ids = new Map([
      [firstPath, "123e4567-e89b-42d3-a456-426614174010"],
      [secondPath, "123e4567-e89b-42d3-a456-426614174011"],
    ])
    const service = new WorkspaceService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      catalog,
      readWorkspace: async ({ workspacePath }) => ({
        id: ids.get(workspacePath) ?? "missing",
        domain: workspacePath === firstPath ? "First domain" : "Second domain",
        setupStatus: "ready",
      }),
      migrateWorkspace: async () => {
        throw new Error("migration should not run")
      },
      openIndex: async ({ workspacePath, databasePath }) => {
        calls.push(`open:${databasePath}`)
        return createFakeIndex(calls, workspacePath)
      },
    })

    const first = await service.openWorkspace(firstPath)
    const second = await service.openWorkspace(secondPath)

    assert.equal(first.name, "First Wiki")
    assert.equal(second.domain, "Second domain")
    assert.equal(second.commitHash, "initial-commit")
    assert.equal(second.setupStatus, "ready")
    assert.equal(service.getCurrentWorkspace()?.id, second.id)
    assert.match(calls[0] ?? "", new RegExp(`${first.id}\\.sqlite$`))
    assert.match(calls[2] ?? "", new RegExp(`${second.id}\\.sqlite$`))
    assert.deepEqual(await service.listWorkspaces(), [
      {
        id: first.id,
        name: "First Wiki",
        displayPath: firstPath,
        active: false,
        running: false,
      },
      {
        id: second.id,
        name: "Second Wiki",
        displayPath: secondPath,
        active: true,
        running: false,
      },
    ])
    await service.activateWorkspace(first.id)
    assert.equal(service.getCurrentWorkspace()?.id, first.id)
    assert.equal(
      calls.filter((call) => call === `close:${firstPath}`).length,
      0
    )
    assert.equal(calls.filter((call) => call.startsWith("open:")).length, 2)
    assert.deepEqual(catalog.lastActive, { id: first.id, path: firstPath })

    await service.dispose()
    assert.equal(calls.filter((call) => call.startsWith("close:")).length, 2)
  })

  it("switches workspaces during ingest and keeps updates with their origin", async () => {
    const parent = await temporaryDirectory()
    const firstPath = join(parent, "First Wiki")
    const secondPath = join(parent, "Second Wiki")
    await Promise.all([mkdir(firstPath), mkdir(secondPath)])
    const firstId = "123e4567-e89b-42d3-a456-426614174040"
    const secondId = "123e4567-e89b-42d3-a456-426614174041"
    let finishIngest: (() => void) | undefined
    const ingestBlocked = new Promise<void>((resolve) => {
      finishIngest = resolve
    })
    const catalog = createFakeCatalog()
    const events: Array<{ workspaceId: string; status: string }> = []
    const service = new WorkspaceService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createId: () => "stable-id-1234567890",
      catalog,
      readWorkspace: async ({ workspacePath }) => ({
        id: workspacePath === firstPath ? firstId : secondId,
        domain: "Research",
        setupStatus: "initialized",
      }),
      createAgent: async () => createFakeAgent(),
      createEngine: () => ({
        async initialize() {
          throw new Error("initialization should not run")
        },
        async ingest() {
          await ingestBlocked
          return ingestResult()
        },
      }),
      openIndex: async ({ workspacePath: indexWorkspacePath }) =>
        createFakeIndex([], indexWorkspacePath),
    })
    service.subscribeIngestChanged(({ workspaceId, job }) => {
      events.push({ workspaceId, status: job.status })
    })
    await service.openWorkspace(firstPath)
    await service.openWorkspace(secondPath)
    await service.activateWorkspace(firstId)
    const documentPath = join(parent, "Source.md")
    await writeFile(documentPath, "Material")
    const document = await service.registerSourceDocument(7, documentPath)
    await service.startIngest(7, {
      documentToken: document.token,
      objective: "Capture it",
    })

    assert.equal(service.getCurrentIngest()?.status, "running")
    assert.equal((await service.listWorkspaces())[0]?.running, true)
    await service.activateWorkspace(secondId)
    assert.equal(service.getCurrentWorkspace()?.id, secondId)
    assert.equal(service.getCurrentIngest(), null)
    assert.deepEqual(
      (await service.listWorkspaces()).map(({ id, active, running }) => ({
        id,
        active,
        running,
      })),
      [
        { id: firstId, active: false, running: true },
        { id: secondId, active: true, running: false },
      ]
    )

    const secondDocument = await service.registerSourceDocument(7, documentPath)
    await assert.rejects(
      service.startIngest(7, {
        documentToken: secondDocument.token,
        objective: "Do not start concurrently",
      }),
      (error: unknown) =>
        error instanceof WorkspaceServiceError && error.code === "busy"
    )
    finishIngest?.()
    await waitForTerminalEvent(events, firstId)
    assert.equal(service.getCurrentWorkspace()?.commitHash, "initial-commit")
    assert.ok(events.every(({ workspaceId }) => workspaceId === firstId))

    await service.activateWorkspace(firstId)
    assert.equal(service.getCurrentIngest()?.status, "completed")
    assert.equal(
      service.getCurrentIngest()?.result?.commitHash,
      "ingest-commit"
    )
    assert.equal(service.getCurrentWorkspace()?.commitHash, "ingest-commit")
    assert.equal(service.getCurrentWorkspace()?.setupStatus, "ready")
    await service.dispose()
  })

  it("rejects a document token after switching away from its workspace", async () => {
    const parent = await temporaryDirectory()
    const firstPath = join(parent, "First Wiki")
    const secondPath = join(parent, "Second Wiki")
    await Promise.all([mkdir(firstPath), mkdir(secondPath)])
    const service = new WorkspaceService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createId: () => "stable-id-1234567890",
      catalog: createFakeCatalog(),
      readWorkspace: async ({ workspacePath }) => ({
        id:
          workspacePath === firstPath
            ? "123e4567-e89b-42d3-a456-426614174050"
            : "123e4567-e89b-42d3-a456-426614174051",
        domain: "Research",
        setupStatus: "ready",
      }),
      openIndex: async ({ workspacePath: indexWorkspacePath }) =>
        createFakeIndex([], indexWorkspacePath),
    })
    await service.openWorkspace(firstPath)
    const documentPath = join(parent, "Source.txt")
    await writeFile(documentPath, "Material")
    const document = await service.registerSourceDocument(7, documentPath)
    await service.openWorkspace(secondPath)

    await assert.rejects(
      service.startIngest(7, {
        documentToken: document.token,
        objective: "Capture it",
      }),
      (error: unknown) =>
        error instanceof WorkspaceServiceError && error.code === "invalid-input"
    )
    await service.dispose()
  })

  it("lists visible workspace files and reads selected file content", async () => {
    const parent = await temporaryDirectory()
    const workspacePath = join(parent, "Wiki")
    await mkdir(join(workspacePath, "concepts"), { recursive: true })
    await mkdir(join(workspacePath, ".git"))
    await mkdir(join(workspacePath, ".amend"))
    await writeFile(join(workspacePath, "concepts", "Cache.md"), "# Cache")
    await writeFile(join(workspacePath, "notes.txt"), "plain notes")
    await writeFile(join(workspacePath, "paper.pdf"), "pdf bytes")
    await writeFile(join(workspacePath, ".hidden.md"), "hidden")
    const service = new WorkspaceService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      catalog: createFakeCatalog(),
      readWorkspace: async () => ({
        id: "123e4567-e89b-42d3-a456-426614174060",
        domain: "Research",
        setupStatus: "ready",
      }),
      openIndex: async ({ workspacePath: indexWorkspacePath }) =>
        createFakeIndex([], indexWorkspacePath),
    })
    await service.openWorkspace(workspacePath)

    assert.deepEqual(await service.listFiles(), [
      {
        path: "concepts",
        name: "concepts",
        kind: "directory",
        children: [
          { path: "concepts/Cache.md", name: "Cache.md", kind: "file" },
        ],
      },
      { path: "notes.txt", name: "notes.txt", kind: "file" },
      { path: "paper.pdf", name: "paper.pdf", kind: "file" },
    ])
    assert.deepEqual(await service.readFile({ path: "concepts/Cache.md" }), {
      path: "concepts/Cache.md",
      name: "Cache.md",
      mediaType: "markdown",
      size: 7,
      content: "# Cache",
    })
    assert.deepEqual(await service.readFile({ path: "paper.pdf" }), {
      path: "paper.pdf",
      name: "paper.pdf",
      mediaType: "binary",
      size: 9,
    })
    await assert.rejects(
      service.readFile({ path: "../outside.md" }),
      (error: unknown) =>
        error instanceof WorkspaceServiceError && error.code === "invalid-input"
    )
    await assert.rejects(
      service.readFile({ path: ".amend/workspace.json" }),
      (error: unknown) =>
        error instanceof WorkspaceServiceError && error.code === "invalid-input"
    )
    await service.dispose()
  })

  it("explicitly migrates a legacy workspace before opening it", async () => {
    const parent = await temporaryDirectory()
    const workspacePath = join(parent, "Legacy Wiki")
    await mkdir(workspacePath)
    const calls: string[] = []
    const service = new WorkspaceService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      catalog: createFakeCatalog(),
      readWorkspace: async () => {
        calls.push("read")
        throw new Error("Invalid wiki workspace manifest")
      },
      migrateWorkspace: async () => {
        calls.push("migrate")
        return {
          id: "123e4567-e89b-42d3-a456-426614174012",
          domain: "Legacy domain",
          setupStatus: "initialized",
        }
      },
      openIndex: async ({ databasePath }) => {
        calls.push(databasePath)
        return createFakeIndex(calls)
      },
    })

    const workspace = await service.openWorkspace(workspacePath)

    assert.equal(workspace.domain, "Legacy domain")
    assert.deepEqual(calls.slice(0, 2), ["read", "migrate"])
    assert.match(calls[2] ?? "", /426614174012\.sqlite$/)
    await service.dispose()
  })

  it("preserves the active workspace when catalog activation fails", async () => {
    const parent = await temporaryDirectory()
    const firstPath = join(parent, "First")
    const secondPath = join(parent, "Second")
    await Promise.all([mkdir(firstPath), mkdir(secondPath)])
    const calls: string[] = []
    const catalog = createFakeCatalog()
    const service = new WorkspaceService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      catalog,
      readWorkspace: async ({ workspacePath }) => ({
        id:
          workspacePath === firstPath
            ? "123e4567-e89b-42d3-a456-426614174020"
            : "123e4567-e89b-42d3-a456-426614174021",
        domain: "Research",
        setupStatus: "ready",
      }),
      openIndex: async ({ workspacePath }) =>
        createFakeIndex(calls, workspacePath),
    })
    const first = await service.openWorkspace(firstPath)
    catalog.failActivation = true

    await assert.rejects(service.openWorkspace(secondPath))

    assert.equal(service.getCurrentWorkspace()?.id, first.id)
    assert.equal(
      calls.filter((call) => call === `close:${secondPath}`).length,
      1
    )
    assert.equal(calls.includes(`close:${firstPath}`), false)
    await service.dispose()
  })

  it("clears a stale last-active record without failing restoration", async () => {
    const parent = await temporaryDirectory()
    const workspacePath = join(parent, "Moved Wiki")
    await mkdir(workspacePath)
    const catalog = createFakeCatalog({
      id: "123e4567-e89b-42d3-a456-426614174030",
      path: workspacePath,
    })
    const service = new WorkspaceService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      catalog,
      readWorkspace: async () => ({
        id: "123e4567-e89b-42d3-a456-426614174031",
        domain: "Replacement",
        setupStatus: "initialized",
      }),
      openIndex: async () => createFakeIndex([]),
    })

    assert.equal(await service.restoreLastActiveWorkspace(), null)
    assert.equal(service.getCurrentWorkspace(), null)
    assert.equal(catalog.lastActive, null)
    assert.equal(catalog.clearCount, 1)
    await service.dispose()
  })

  it("rebuilds a derived index whose stored path predates a workspace move", async () => {
    const parent = await temporaryDirectory()
    const workspacePath = join(parent, "Moved Wiki")
    await mkdir(workspacePath)
    let openAttempts = 0
    const service = new WorkspaceService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      catalog: createFakeCatalog(),
      readWorkspace: async () => ({
        id: "123e4567-e89b-42d3-a456-426614174032",
        domain: "Moved research",
        setupStatus: "ready",
      }),
      openIndex: async () => {
        openAttempts += 1
        if (openAttempts === 1) {
          throw new WikiIndexError(
            "invalid-database",
            "Wiki index database belongs to another workspace"
          )
        }
        return createFakeIndex([])
      },
    })

    const workspace = await service.openWorkspace(workspacePath)

    assert.equal(workspace.setupStatus, "ready")
    assert.equal(openAttempts, 2)
    await service.dispose()
  })

  it("closes an existing same-ID index before rebuilding its moved cache", async () => {
    const parent = await temporaryDirectory()
    const firstPath = join(parent, "Original Wiki")
    const movedPath = join(parent, "Moved Wiki")
    await Promise.all([mkdir(firstPath), mkdir(movedPath)])
    const workspaceId = "123e4567-e89b-42d3-a456-426614174033"
    const calls: string[] = []
    let movedAttempts = 0
    const service = new WorkspaceService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      catalog: createFakeCatalog(),
      readWorkspace: async () => ({
        id: workspaceId,
        domain: "Moved research",
        setupStatus: "ready",
      }),
      openIndex: async ({ workspacePath }) => {
        calls.push(`open:${workspacePath}`)
        if (workspacePath === movedPath) {
          movedAttempts += 1
          if (movedAttempts === 1) {
            throw new WikiIndexError(
              "invalid-database",
              "Wiki index database belongs to another workspace"
            )
          }
        }
        return createFakeIndex(calls, workspacePath)
      },
    })
    await service.openWorkspace(firstPath)

    const workspace = await service.openWorkspace(movedPath)

    assert.equal(workspace.displayPath, movedPath)
    assert.deepEqual(calls.slice(0, 6), [
      `open:${firstPath}`,
      "refresh",
      `open:${movedPath}`,
      `close:${firstPath}`,
      `open:${movedPath}`,
      "refresh",
    ])
    await service.dispose()
  })
})

async function waitForTerminalJob(
  service: WorkspaceService
): Promise<NonNullable<ReturnType<WorkspaceService["getCurrentIngest"]>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = service.getCurrentIngest()
    if (job && job.status !== "running") return job
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Timed out waiting for ingest job")
}

async function waitForTerminalEvent(
  events: readonly { workspaceId: string; status: string }[],
  workspaceId: string
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      events.some(
        (event) =>
          event.workspaceId === workspaceId && event.status !== "running"
      )
    ) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Timed out waiting for ingest event")
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "amend-desktop-service-"))
  temporaryDirectories.push(directory)
  return directory
}

function createFakeAgent(): WikiAgent {
  return {
    name: "fake/wiki-agent",
    async run() {
      return { summary: "Integrated source" }
    },
  }
}

function createFakeEngine(calls: string[], sourcePaths: string[]): WikiEngine {
  return {
    async initialize({ workspacePath }) {
      calls.push("initialize")
      await mkdir(workspacePath)
      return {
        workspacePath,
        id: "123e4567-e89b-42d3-a456-426614174003",
        commitHash: "initial-commit",
      }
    },
    async ingest({ sources }) {
      calls.push("ingest")
      sourcePaths.push(...sources.map(({ path }) => path))
      return ingestResult()
    },
  }
}

function createCancellableEngine(): WikiEngine {
  return {
    async initialize({ workspacePath }) {
      await mkdir(workspacePath)
      return {
        workspacePath,
        id: "123e4567-e89b-42d3-a456-426614174004",
        commitHash: "initial-commit",
      }
    },
    async ingest({ signal }) {
      return await new Promise<WikiRunResult>((_resolve, reject) => {
        const rejectAbort = () =>
          reject(new DOMException("Cancelled", "AbortError"))
        if (signal?.aborted) rejectAbort()
        else signal?.addEventListener("abort", rejectAbort, { once: true })
      })
    },
  }
}

function ingestResult(): WikiRunResult {
  return {
    runId: "run-id",
    baseCommit: "initial-commit",
    commitHash: "ingest-commit",
    changedFiles: ["concepts/page.md"],
    summary: "Integrated source",
    agent: "fake/wiki-agent",
  }
}

function createFakeIndex(calls: string[], workspacePath = "/wiki"): WikiIndex {
  let refresh = 0
  return {
    workspacePath,
    databasePath: "/index.sqlite",
    async refresh() {
      calls.push("refresh")
      refresh += 1
      return {
        commitHash: refresh === 1 ? "initial-commit" : "ingest-commit",
        added: refresh === 1 ? 0 : 1,
        updated: 0,
        removed: 0,
        unchanged: 0,
      }
    },
    async search() {
      return []
    },
    async listTags() {
      return []
    },
    async close() {
      calls.push(workspacePath === "/wiki" ? "close" : `close:${workspacePath}`)
    },
  }
}

function createFakeCatalog(initial: WorkspaceCatalogRecord | null = null) {
  return {
    records: initial ? [initial] : ([] as WorkspaceCatalogRecord[]),
    lastActive: initial,
    clearCount: 0,
    failActivation: false,
    async listWorkspaces() {
      return this.records
    },
    async findLastActiveWorkspace() {
      return this.lastActive
    },
    async upsertAndActivate(record: WorkspaceCatalogRecord) {
      if (this.failActivation) throw new Error("Catalog write failed")
      const index = this.records.findIndex(({ id }) => id === record.id)
      if (index === -1) this.records.push(record)
      else this.records[index] = record
      this.lastActive = record
    },
    async clearLastActive() {
      this.clearCount += 1
      this.lastActive = null
    },
  }
}
