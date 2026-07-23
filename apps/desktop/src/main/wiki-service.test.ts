import assert from "node:assert/strict"
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
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
import type {
  WikiUpdateAgentSession,
  WikiUpdateProposalSession,
} from "@workspace/wiki-engine/update"

import { WikiHome } from "./wiki-home.ts"
import { WikiService, WikiServiceError } from "./wiki-service.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("wiki service", () => {
  it("renames a wiki directory while preserving its identity", async () => {
    const parent = await temporaryDirectory()
    const wikiId = "123e4567-e89b-42d3-a456-426614174003"
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createEngine: () => createFakeEngine([], []),
      readWiki: async ({ wikiPath }) => {
        if (
          wikiPath !== join(parent, "Reliability Wiki") &&
          wikiPath !== join(parent, "Operations Wiki")
        ) {
          throw new Error("Not a wiki")
        }
        return {
          id: wikiId,
          domain: "Database reliability",
          setupStatus: "ready",
        }
      },
      openIndex: async ({ workspacePath }) =>
        createFakeIndex([], workspacePath),
    })

    await service.setWikiHome(parent)
    const original = await service.createWiki({
      name: "Reliability Wiki",
      domain: "Database reliability",
    })

    const renamed = await service.renameWiki({
      wikiId: original.id,
      name: "Operations Wiki",
    })

    assert.equal(renamed.id, original.id)
    assert.equal(renamed.name, "Operations Wiki")
    assert.equal(renamed.displayPath, join(parent, "Operations Wiki"))
    assert.deepEqual(
      await service.renameWiki({
        wikiId: original.id,
        name: "Operations Wiki",
      }),
      renamed
    )
    await assert.rejects(access(join(parent, "Reliability Wiki")))
    await assert.doesNotReject(access(renamed.displayPath))
    assert.deepEqual(await service.listWikis(), [
      {
        id: original.id,
        name: "Operations Wiki",
        displayPath: renamed.displayPath,
        active: true,
        running: false,
      },
    ])
    await service.dispose()
  })

  it("rejects a wiki rename when the destination already exists", async () => {
    const parent = await temporaryDirectory()
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createEngine: () => createFakeEngine([], []),
      openIndex: async ({ workspacePath }) =>
        createFakeIndex([], workspacePath),
    })

    await service.setWikiHome(parent)
    const wiki = await service.createWiki({
      name: "Reliability Wiki",
      domain: "Database reliability",
    })
    await mkdir(join(parent, "Operations Wiki"))

    await assert.rejects(
      service.renameWiki({ wikiId: wiki.id, name: "Operations Wiki" }),
      (error: unknown) =>
        error instanceof WikiServiceError && error.code === "invalid-location"
    )
    assert.equal(service.getCurrentWiki()?.name, "Reliability Wiki")
    await service.dispose()
  })

  it("supports changing only the case of a wiki name", async () => {
    const parent = await temporaryDirectory()
    const originalPath = join(parent, "Research Wiki")
    const renamedPath = join(parent, "Research wiki")
    await mkdir(originalPath)
    const wikiId = "123e4567-e89b-42d3-a456-426614174012"
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      readWiki: async ({ wikiPath }) => {
        if (wikiPath !== originalPath && wikiPath !== renamedPath) {
          throw new Error("Not a wiki")
        }
        return { id: wikiId, domain: "Research", setupStatus: "ready" }
      },
      openIndex: async ({ workspacePath }) =>
        createFakeIndex([], workspacePath),
    })

    await service.setWikiHome(parent)
    await service.openWiki(originalPath)

    const renamed = await service.renameWiki({
      wikiId,
      name: "Research wiki",
    })

    assert.equal(renamed.name, "Research wiki")
    assert.equal(renamed.displayPath, renamedPath)
    await assert.doesNotReject(access(renamedPath))
    await service.dispose()
  })

  it("renames an inactive wiki without changing the active wiki", async () => {
    const parent = await temporaryDirectory()
    const firstPath = join(parent, "First Wiki")
    const renamedFirstPath = join(parent, "Renamed First Wiki")
    const secondPath = join(parent, "Second Wiki")
    await Promise.all([mkdir(firstPath), mkdir(secondPath)])
    const firstId = "123e4567-e89b-42d3-a456-426614174010"
    const secondId = "123e4567-e89b-42d3-a456-426614174011"
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      readWiki: async ({ wikiPath }) => {
        if (wikiPath === firstPath || wikiPath === renamedFirstPath) {
          return { id: firstId, domain: "First", setupStatus: "ready" }
        }
        if (wikiPath === secondPath) {
          return { id: secondId, domain: "Second", setupStatus: "ready" }
        }
        throw new Error("Not a wiki")
      },
      openIndex: async ({ workspacePath }) =>
        createFakeIndex([], workspacePath),
    })

    await service.setWikiHome(parent)
    await service.openWiki(firstPath)
    await service.openWiki(secondPath)

    const renamed = await service.renameWiki({
      wikiId: firstId,
      name: "Renamed First Wiki",
    })

    assert.equal(renamed.id, firstId)
    assert.equal(renamed.displayPath, renamedFirstPath)
    assert.equal(service.getCurrentWiki()?.id, secondId)
    assert.deepEqual(
      (await service.listWikis()).map(({ id, name, active }) => ({
        id,
        name,
        active,
      })),
      [
        { id: firstId, name: "Renamed First Wiki", active: false },
        { id: secondId, name: "Second Wiki", active: true },
      ]
    )
    await service.dispose()
  })

  it("restores the original wiki name when reopening the renamed path fails", async () => {
    const parent = await temporaryDirectory()
    const originalPath = join(parent, "Reliability Wiki")
    const renamedPath = join(parent, "Operations Wiki")
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createEngine: () => createFakeEngine([], []),
      readWiki: async ({ wikiPath }) => {
        if (wikiPath !== originalPath && wikiPath !== renamedPath) {
          throw new Error("Not a wiki")
        }
        return {
          id: "123e4567-e89b-42d3-a456-426614174003",
          domain: "Database reliability",
          setupStatus: "ready",
        }
      },
      openIndex: async ({ workspacePath }) => {
        if (workspacePath === renamedPath) {
          throw new Error("Cannot open renamed path")
        }
        return createFakeIndex([], workspacePath)
      },
    })

    await service.setWikiHome(parent)
    const wiki = await service.createWiki({
      name: "Reliability Wiki",
      domain: "Database reliability",
    })

    await assert.rejects(
      service.renameWiki({ wikiId: wiki.id, name: "Operations Wiki" }),
      (error: unknown) =>
        error instanceof WikiServiceError &&
        error.code === "wiki-open-failed" &&
        error.message.includes("original name was restored")
    )
    await assert.doesNotReject(access(originalPath))
    await assert.rejects(access(renamedPath))
    assert.equal(service.getCurrentWiki()?.name, "Reliability Wiki")
    await service.dispose()
  })

  it("creates a wiki as a sibling in the selected Amend library", async () => {
    const parent = await temporaryDirectory()
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createEngine: () => createFakeEngine([], []),
      openIndex: async () => createFakeIndex([]),
    })

    await service.setWikiHome(parent)
    const workspace = await service.createWiki({
      name: "Reliability Wiki",
      domain: "Database reliability",
    })

    assert.equal(workspace.displayPath, join(parent, "Reliability Wiki"))
    assert.deepEqual(await service.listWikis(), [
      {
        id: workspace.id,
        name: "Reliability Wiki",
        displayPath: workspace.displayPath,
        active: true,
        running: false,
      },
    ])
    await service.dispose()
  })

  it("discovers sibling wikis in the selected Amend library", async () => {
    const parent = await temporaryDirectory()
    const workspaceDirectory = parent
    const firstPath = join(workspaceDirectory, "First Wiki")
    const secondPath = join(workspaceDirectory, "Second Wiki")
    await Promise.all([
      mkdir(firstPath, { recursive: true }),
      mkdir(secondPath, { recursive: true }),
    ])
    const ids = new Map([
      [firstPath, "123e4567-e89b-42d3-a456-426614174010"],
      [secondPath, "123e4567-e89b-42d3-a456-426614174011"],
    ])
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      readWiki: async ({ wikiPath: workspacePath }) => {
        const id = ids.get(workspacePath)
        if (!id) throw new Error("Invalid wiki workspace manifest")
        return { id, domain: "Research", setupStatus: "ready" }
      },
      openIndex: async ({ workspacePath }) =>
        createFakeIndex([], workspacePath),
    })
    await service.setWikiHome(parent)

    assert.deepEqual(await service.listWikis(), [
      {
        id: "123e4567-e89b-42d3-a456-426614174010",
        name: "First Wiki",
        displayPath: firstPath,
        active: false,
        running: false,
      },
      {
        id: "123e4567-e89b-42d3-a456-426614174011",
        name: "Second Wiki",
        displayPath: secondPath,
        active: false,
        running: false,
      },
    ])
    await service.dispose()
  })

  it("creates a wiki, ingests a generated source path, and refreshes", async () => {
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
    const service = new WikiService({
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
    service.subscribeIngestChanged(({ job }) =>
      jobs.push(`${job.status}:${job.phase}`)
    )

    const documentPath = join(parent, "Write-ahead logging.md")
    await writeFile(
      documentPath,
      "A WAL records mutations before pages change."
    )
    const document = await service.registerSourceDocument(7, documentPath)
    await service.setWikiHome(parent)
    const workspace = await service.createWiki({
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
    assert.equal(service.getCurrentWiki()?.id, workspace.id)
    assert.equal(started.jobId, "ingest_document-id-1234567890")
    assert.match(workspace.displayPath, /Reliability Wiki$/)
    assert.deepEqual(sourcePaths, [
      "raw/articles/write-ahead-logging-jobid123.md",
    ])
    assert.equal(job.result?.commitHash, "ingest-commit")
    assert.equal(job.result.index.status, "ready")
    assert.equal(job.result.index.summary.commitHash, "ingest-commit")
    assert.equal(service.getCurrentWiki()?.commitHash, "ingest-commit")
    assert.equal(service.getCurrentWiki()?.setupStatus, "ready")
    assert.ok(jobs.includes("running:preparing"))
    assert.ok(jobs.includes("running:indexing"))
    assert.equal(jobs.at(-1), "completed:indexing")
    assert.equal(calls[0], "initialize")
    assert.match(
      calls[1] ?? "",
      /indexes.*123e4567-e89b-42d3-a456-426614174003\.sqlite$/
    )
    assert.deepEqual(calls.slice(2), ["refresh", "ingest", "refresh"])
    await service.dispose()
    assert.equal(calls.at(-1), "close")
  })

  it("reserves wiki creation before checking the target", async () => {
    const parent = await temporaryDirectory()
    let releaseInitialization: (() => void) | undefined
    const initializationBlocked = new Promise<void>((resolve) => {
      releaseInitialization = resolve
    })
    const service = new WikiService({
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
    await service.setWikiHome(parent)
    const first = service.createWiki({
      name: "Wiki",
      domain: "Research",
    })

    await assert.rejects(
      service.createWiki({
        name: "Another Wiki",
        domain: "Research",
      }),
      (error: unknown) =>
        error instanceof WikiServiceError && error.code === "busy"
    )
    releaseInitialization?.()
    await first
    await service.dispose()
  })

  it("cancels an active ingest and keeps the initialized wiki", async () => {
    const parent = await temporaryDirectory()
    const index = createFakeIndex([])
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createId: () => "selection-id-1234567890",
      createAgent: async () => createFakeAgent(),
      createEngine: () => createCancellableEngine(),
      openIndex: async () => index,
    })
    await service.setWikiHome(parent)
    await service.createWiki({
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
    await assert.rejects(
      service.renameWiki({
        wikiId: service.getCurrentWiki()!.id,
        name: "Renamed Wiki",
      }),
      (error: unknown) =>
        error instanceof WikiServiceError && error.code === "busy"
    )
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
    const service = new WikiService({
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
    await service.setWikiHome(parent)
    await service.createWiki({
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
        error instanceof WikiServiceError && error.code === "operation-failed"
    )

    releaseCommit?.()
    assert.equal((await waitForTerminalJob(service)).status, "completed")
    await service.dispose()
  })

  it("lists and activates open wikis without reopening their indexes", async () => {
    const parent = await temporaryDirectory()
    const workspaceDirectory = parent
    const firstPath = join(workspaceDirectory, "First Wiki")
    const secondPath = join(workspaceDirectory, "Second Wiki")
    await Promise.all([
      mkdir(firstPath, { recursive: true }),
      mkdir(secondPath, { recursive: true }),
    ])
    const calls: string[] = []
    const ids = new Map([
      [firstPath, "123e4567-e89b-42d3-a456-426614174010"],
      [secondPath, "123e4567-e89b-42d3-a456-426614174011"],
    ])
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      readWiki: async ({ wikiPath: workspacePath }) => {
        const id = ids.get(workspacePath)
        if (!id) throw new Error("Invalid wiki workspace manifest")
        return {
          id,
          domain:
            workspacePath === firstPath ? "First domain" : "Second domain",
          setupStatus: "ready",
        }
      },
      openIndex: async ({ workspacePath, databasePath }) => {
        calls.push(`open:${databasePath}`)
        return createFakeIndex(calls, workspacePath)
      },
    })

    await service.setWikiHome(parent)
    const first = await service.openWiki(firstPath)
    const second = await service.openWiki(secondPath)

    assert.equal(first.name, "First Wiki")
    assert.equal(second.domain, "Second domain")
    assert.equal(second.commitHash, "initial-commit")
    assert.equal(second.setupStatus, "ready")
    assert.equal(service.getCurrentWiki()?.id, second.id)
    assert.match(calls[0] ?? "", new RegExp(`${first.id}\\.sqlite$`))
    assert.match(calls[2] ?? "", new RegExp(`${second.id}\\.sqlite$`))
    assert.deepEqual(await service.listWikis(), [
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
    await service.activateWiki(first.id)
    assert.equal(service.getCurrentWiki()?.id, first.id)
    assert.equal(
      calls.filter((call) => call === `close:${firstPath}`).length,
      0
    )
    assert.equal(calls.filter((call) => call.startsWith("open:")).length, 2)
    await service.dispose()
    assert.equal(calls.filter((call) => call.startsWith("close:")).length, 2)
  })

  it("switches wikis during ingest and keeps updates with their origin", async () => {
    const parent = await temporaryDirectory()
    const workspaceDirectory = parent
    const firstPath = join(workspaceDirectory, "First Wiki")
    const secondPath = join(workspaceDirectory, "Second Wiki")
    await Promise.all([
      mkdir(firstPath, { recursive: true }),
      mkdir(secondPath, { recursive: true }),
    ])
    const firstId = "123e4567-e89b-42d3-a456-426614174040"
    const secondId = "123e4567-e89b-42d3-a456-426614174041"
    let finishIngest: (() => void) | undefined
    const ingestBlocked = new Promise<void>((resolve) => {
      finishIngest = resolve
    })
    const events: Array<{ wikiId: string; status: string }> = []
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createId: () => "stable-id-1234567890",
      readWiki: async ({ wikiPath: workspacePath }) => {
        if (workspacePath === firstPath) {
          return { id: firstId, domain: "Research", setupStatus: "initialized" }
        }
        if (workspacePath === secondPath) {
          return {
            id: secondId,
            domain: "Research",
            setupStatus: "initialized",
          }
        }
        throw new Error("Invalid wiki manifest")
      },
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
    service.subscribeIngestChanged(({ wikiId, job }) => {
      events.push({ wikiId, status: job.status })
    })
    await service.setWikiHome(parent)
    await service.openWiki(firstPath)
    await service.openWiki(secondPath)
    await service.activateWiki(firstId)
    const documentPath = join(parent, "Source.md")
    await writeFile(documentPath, "Material")
    const document = await service.registerSourceDocument(7, documentPath)
    await service.startIngest(7, {
      documentToken: document.token,
      objective: "Capture it",
    })

    assert.equal(service.getCurrentIngest()?.status, "running")
    assert.equal((await service.listWikis())[0]?.running, true)
    await service.activateWiki(secondId)
    assert.equal(service.getCurrentWiki()?.id, secondId)
    assert.equal(service.getCurrentIngest(), null)
    assert.deepEqual(
      (await service.listWikis()).map(({ id, active, running }) => ({
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
        error instanceof WikiServiceError && error.code === "busy"
    )
    finishIngest?.()
    await waitForTerminalEvent(events, firstId)
    assert.equal(service.getCurrentWiki()?.commitHash, "initial-commit")
    assert.ok(events.every(({ wikiId }) => wikiId === firstId))

    await service.activateWiki(firstId)
    assert.equal(service.getCurrentIngest()?.status, "completed")
    assert.equal(
      service.getCurrentIngest()?.result?.commitHash,
      "ingest-commit"
    )
    assert.equal(service.getCurrentWiki()?.commitHash, "ingest-commit")
    assert.equal(service.getCurrentWiki()?.setupStatus, "ready")
    await service.dispose()
  })

  it("accepts a document token after switching wikis", async () => {
    const parent = await temporaryDirectory()
    const workspaceDirectory = parent
    const firstPath = join(workspaceDirectory, "First Wiki")
    const secondPath = join(workspaceDirectory, "Second Wiki")
    await Promise.all([
      mkdir(firstPath, { recursive: true }),
      mkdir(secondPath, { recursive: true }),
    ])
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createId: () => "stable-id-1234567890",
      readWiki: async ({ wikiPath: workspacePath }) => ({
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
    await service.setWikiHome(parent)
    await service.openWiki(firstPath)
    const documentPath = join(parent, "Source.txt")
    await writeFile(documentPath, "Material")
    const document = await service.registerSourceDocument(7, documentPath)
    await service.openWiki(secondPath)

    await assert.doesNotReject(
      service.startIngest(7, {
        documentToken: document.token,
        objective: "Capture it",
      })
    )
    await service.dispose()
  })

  it("lists visible wiki files and reads selected file content", async () => {
    const parent = await temporaryDirectory()
    const workspacePath = join(parent, "Wiki")
    await mkdir(join(workspacePath, "concepts"), { recursive: true })
    await mkdir(join(workspacePath, ".git"))
    await mkdir(join(workspacePath, ".amend"))
    await writeFile(join(workspacePath, "concepts", "Cache.md"), "# Cache")
    await writeFile(join(workspacePath, "notes.txt"), "plain notes")
    await writeFile(join(workspacePath, "paper.pdf"), "pdf bytes")
    await writeFile(join(workspacePath, ".hidden.md"), "hidden")
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      readWiki: async () => ({
        id: "123e4567-e89b-42d3-a456-426614174060",
        domain: "Research",
        setupStatus: "ready",
      }),
      openIndex: async ({ workspacePath: indexWorkspacePath }) =>
        createFakeIndex([], indexWorkspacePath),
    })
    await service.setWikiHome(parent)
    await service.openWiki(workspacePath)

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
        error instanceof WikiServiceError && error.code === "invalid-input"
    )
    await assert.rejects(
      service.readFile({ path: ".amend/wiki.json" }),
      (error: unknown) =>
        error instanceof WikiServiceError && error.code === "invalid-input"
    )
    await service.dispose()
  })

  it("does not open an invalid wiki", async () => {
    const parent = await temporaryDirectory()
    const workspacePath = join(parent, "Legacy Wiki")
    await mkdir(workspacePath)
    const calls: string[] = []
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      readWiki: async () => {
        calls.push("read")
        throw new Error("Invalid wiki workspace manifest")
      },
    })

    await service.setWikiHome(parent)
    await assert.rejects(
      service.openWiki(workspacePath),
      (error: unknown) =>
        error instanceof WikiServiceError && error.code === "wiki-open-failed"
    )
    assert.deepEqual(calls, ["read"])
    await service.dispose()
  })

  it("activates another wiki discovered in the Amend library", async () => {
    const parent = await temporaryDirectory()
    const firstPath = join(parent, "First")
    const secondPath = join(parent, "Second")
    await Promise.all([mkdir(firstPath), mkdir(secondPath)])
    const calls: string[] = []
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      readWiki: async ({ wikiPath: workspacePath }) => ({
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
    await service.setWikiHome(parent)
    const first = await service.openWiki(firstPath)
    const second = await service.openWiki(secondPath)

    assert.equal(first.id === second.id, false)
    assert.equal(service.getCurrentWiki()?.id, second.id)
    await service.dispose()
  })

  it("clears a stale last-active record without failing restoration", async () => {
    const parent = await temporaryDirectory()
    const workspacePath = join(parent, "Moved Wiki")
    await mkdir(workspacePath)
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      readWiki: async () => ({
        id: "123e4567-e89b-42d3-a456-426614174031",
        domain: "Replacement",
        setupStatus: "initialized",
      }),
      openIndex: async () => createFakeIndex([]),
    })

    await service.setWikiHome(parent)
    const home = new WikiHome({ userDataPath: join(parent, "user-data") })
    await home.setLastActiveWikiId("123e4567-e89b-42d3-a456-426614174030")

    assert.equal(await service.restoreLastActiveWiki(), null)
    assert.equal(service.getCurrentWiki(), null)
    assert.equal((await home.read())?.lastActiveWikiId, null)
    await service.dispose()
  })

  it("rebuilds a derived index whose stored path predates a wiki move", async () => {
    const parent = await temporaryDirectory()
    const workspacePath = join(parent, "Moved Wiki")
    await mkdir(workspacePath)
    let openAttempts = 0
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      readWiki: async () => ({
        id: "123e4567-e89b-42d3-a456-426614174032",
        domain: "Moved research",
        setupStatus: "ready",
      }),
      openIndex: async () => {
        openAttempts += 1
        if (openAttempts === 1) {
          throw new WikiIndexError(
            "invalid-database",
            "Wiki index database belongs to another wiki"
          )
        }
        return createFakeIndex([])
      },
    })

    await service.setWikiHome(parent)
    const workspace = await service.openWiki(workspacePath)

    assert.equal(workspace.setupStatus, "ready")
    assert.equal(openAttempts, 2)
    await service.dispose()
  })

  it("closes an existing same-ID index before rebuilding its moved cache", async () => {
    const parent = await temporaryDirectory()
    const firstPath = join(parent, "Original Wiki")
    const movedPath = join(parent, "Moved Wiki")
    await Promise.all([mkdir(firstPath), mkdir(movedPath)])
    const wikiId = "123e4567-e89b-42d3-a456-426614174033"
    const calls: string[] = []
    let movedAttempts = 0
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      readWiki: async () => ({
        id: wikiId,
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
              "Wiki index database belongs to another wiki"
            )
          }
        }
        return createFakeIndex(calls, workspacePath)
      },
    })
    await service.setWikiHome(parent)
    await service.openWiki(firstPath)

    const workspace = await service.openWiki(movedPath)

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

  it("streams a wiki update, reconnects to review, and applies it", async () => {
    const parent = await temporaryDirectory()
    const calls: string[] = []
    const service = new WikiService({
      userDataPath: join(parent, "user-data"),
      skillPath: "/app/llm-wiki/SKILL.md",
      createId: () => "123e4567-e89b-42d3-a456-426614174040",
      createEngine: () => createFakeEngine(calls, []),
      createUpdateAgent: async () => createFakeUpdateAgent(),
      createUpdateProposal: async () => createFakeUpdateProposal(calls),
      openIndex: async () => createFakeIndex(calls),
    })
    await service.setWikiHome(parent)
    await service.createWiki({ name: "Wiki", domain: "Research" })
    const events: Array<{ status: string; revision: number }> = []
    service.subscribeUpdateChanged(({ session }) => {
      if (session)
        events.push({ status: session.status, revision: session.revision })
    })

    const started = await service.startUpdate({
      prompt: "Clarify the page.",
      contextPath: "concepts/page.md",
    })
    const session = await waitForUpdateReview(service)

    assert.equal(session.id, started.sessionId)
    assert.equal(session.messages.at(-1)?.content, "Updated the page.")
    assert.equal(session.activity[0]?.label, "Edited concepts/page.md")
    assert.equal(session.proposal?.changedFiles[0]?.path, "concepts/page.md")
    assert.deepEqual(
      await service.readUpdateDiff({
        sessionId: session.id,
        path: "concepts/page.md",
      }),
      { path: "concepts/page.md", patch: "@@ -1 +1 @@" }
    )
    await assert.rejects(
      service.renameWiki({
        wikiId: service.getCurrentWiki()!.id,
        name: "Renamed Wiki",
      }),
      (error: unknown) =>
        error instanceof WikiServiceError && error.code === "busy"
    )

    const result = await service.applyUpdate({ sessionId: session.id })

    assert.equal(result.commitHash, "update-commit")
    assert.equal(service.getCurrentUpdate(), null)
    assert.equal(service.getCurrentWiki()?.commitHash, "update-commit")
    assert.ok(events.some(({ status }) => status === "running"))
    assert.equal(events.at(-1)?.status, "applying")
    assert.ok(calls.includes("apply-update"))
    await service.dispose()
  })
})

async function waitForTerminalJob(
  service: WikiService
): Promise<NonNullable<ReturnType<WikiService["getCurrentIngest"]>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = service.getCurrentIngest()
    if (job && job.status !== "running") return job
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Timed out waiting for ingest job")
}

async function waitForTerminalEvent(
  events: readonly { wikiId: string; status: string }[],
  wikiId: string
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      events.some(
        (event) => event.wikiId === wikiId && event.status !== "running"
      )
    ) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Timed out waiting for ingest event")
}

async function waitForUpdateReview(service: WikiService) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = service.getCurrentUpdate()
    if (session && session.status === "review") return session
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Timed out waiting for wiki update review")
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

function createFakeUpdateAgent(): WikiUpdateAgentSession {
  return {
    name: "fake/update-agent",
    async prompt() {
      return { output: "Updated the page.", summary: "Update page" }
    },
    async abort() {},
    dispose() {},
  }
}

function createFakeUpdateProposal(calls: string[]): WikiUpdateProposalSession {
  return {
    workspacePath: "/wiki",
    baseCommit: "initial-commit",
    agentName: "fake/update-agent",
    async runTurn({ onEvent }) {
      onEvent?.({
        type: "tool-start",
        callId: "activity_12345678",
        toolName: "edit",
        input: { path: "concepts/page.md" },
      })
      onEvent?.({ type: "assistant-delta", text: "Updated the page." })
      onEvent?.({
        type: "tool-end",
        callId: "activity_12345678",
        toolName: "edit",
        isError: false,
      })
      return {
        summary: "Update page",
        output: "Updated the page.",
        changedFiles: [
          {
            path: "concepts/page.md",
            status: "modified",
            additions: 1,
            deletions: 1,
          },
        ],
      }
    },
    async readDiff() {
      return "@@ -1 +1 @@"
    },
    async apply() {
      calls.push("apply-update")
      return {
        runId: "update_12345678",
        baseCommit: "initial-commit",
        commitHash: "update-commit",
        changedFiles: ["concepts/page.md", "log.md"],
        summary: "Update page",
        agent: "fake/update-agent",
      }
    },
    async discard() {
      calls.push("discard-update")
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
