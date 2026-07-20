import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "node:test"

import type { WikiIndex } from "@workspace/wiki-engine/index"
import type {
  WikiAgent,
  WikiEngine,
  WikiRunResult,
} from "@workspace/wiki-engine/ingest"

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
      openIndex: async ({ databasePath }) => {
        calls.push(`open-index:${databasePath}`)
        return index
      },
    })
    const jobs: string[] = []
    service.subscribeIngestChanged((job) =>
      jobs.push(`${job.status}:${job.phase}`)
    )

    const selection = await service.registerParentSelection(7, parent)
    const workspace = await service.createWorkspace(7, {
      selectionToken: selection.token,
      name: "Reliability Wiki",
      domain: "Database reliability",
    })
    const documentPath = join(parent, "Write-ahead logging.md")
    await writeFile(
      documentPath,
      "A WAL records mutations before pages change."
    )
    const document = await service.registerSourceDocument(7, documentPath)
    const started = await service.startIngest(7, {
      documentToken: document.token,
      objective: "Capture the recovery ordering guarantees.",
    })
    const job = await waitForTerminalJob(service)

    assert.equal(workspace.name, "Reliability Wiki")
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
    assert.ok(jobs.includes("running:preparing"))
    assert.ok(jobs.includes("running:indexing"))
    assert.equal(jobs.at(-1), "completed:indexing")
    assert.equal(calls[0], "initialize")
    assert.match(calls[1] ?? "", /^open-index:.*indexes.*\.sqlite$/)
    assert.deepEqual(calls.slice(2), ["refresh", "ingest", "refresh"])

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
          return { workspacePath, commitHash: "initial-commit" }
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
          return { workspacePath, commitHash: "initial-commit" }
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
      return { workspacePath, commitHash: "initial-commit" }
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
      return { workspacePath, commitHash: "initial-commit" }
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

function createFakeIndex(calls: string[]): WikiIndex {
  let refresh = 0
  return {
    workspacePath: "/wiki",
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
      calls.push("close")
    },
  }
}
