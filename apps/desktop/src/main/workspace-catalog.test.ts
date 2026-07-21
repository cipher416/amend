import assert from "node:assert/strict"
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "vitest"

import { WorkspaceCatalog } from "./workspace-catalog.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("workspace catalog", () => {
  it("returns an empty catalog when the file is missing", async () => {
    const userDataPath = await temporaryDirectory()
    const catalog = new WorkspaceCatalog({ userDataPath })

    assert.deepEqual(await catalog.listWorkspaces(), [])
    assert.equal(await catalog.findLastActiveWorkspace(), null)
  })

  it("creates the catalog directory and atomically persists an active workspace", async () => {
    const userDataPath = await temporaryDirectory()
    const catalog = new WorkspaceCatalog({ userDataPath })
    const record = { id: "workspace-1", path: "/wikis/one" }

    await catalog.upsertAndActivate(record)

    assert.deepEqual(await catalog.listWorkspaces(), [record])
    assert.deepEqual(await catalog.findLastActiveWorkspace(), record)
    assert.equal(
      await catalogSource(userDataPath),
      `${JSON.stringify(
        {
          version: 1,
          lastActiveWorkspaceId: "workspace-1",
          workspaces: [record],
        },
        null,
        2
      )}\n`
    )
    assert.deepEqual(await readdir(join(userDataPath, "workspaces")), [
      "catalog.json",
    ])
  })

  it("upserts by ID, preserves other records, and restores across instances", async () => {
    const userDataPath = await temporaryDirectory()
    const catalog = new WorkspaceCatalog({ userDataPath })
    await catalog.upsertAndActivate({ id: "workspace-1", path: "/old/one" })
    await catalog.upsertAndActivate({ id: "workspace-2", path: "/wikis/two" })

    await catalog.upsertAndActivate({ id: "workspace-1", path: "/new/one" })

    const restored = new WorkspaceCatalog({ userDataPath })
    assert.deepEqual(await restored.listWorkspaces(), [
      { id: "workspace-1", path: "/new/one" },
      { id: "workspace-2", path: "/wikis/two" },
    ])
    assert.deepEqual(await restored.findLastActiveWorkspace(), {
      id: "workspace-1",
      path: "/new/one",
    })
  })

  it("stores caller-provided paths verbatim without resolving or checking them", async () => {
    const userDataPath = await temporaryDirectory()
    const catalog = new WorkspaceCatalog({ userDataPath })
    const record = { id: "workspace-1", path: "relative/../missing-wiki" }

    await catalog.upsertAndActivate(record)

    assert.deepEqual(await catalog.listWorkspaces(), [record])
  })

  it("returns null when a valid catalog has a stale last-active ID", async () => {
    const userDataPath = await temporaryDirectory()
    await writeCatalog(
      userDataPath,
      JSON.stringify({
        version: 1,
        lastActiveWorkspaceId: "forgotten-workspace",
        workspaces: [{ id: "workspace-1", path: "/wikis/one" }],
      })
    )
    const catalog = new WorkspaceCatalog({ userDataPath })

    assert.equal(await catalog.findLastActiveWorkspace(), null)
    assert.deepEqual(await catalog.listWorkspaces(), [
      { id: "workspace-1", path: "/wikis/one" },
    ])
  })

  it("repairs a moved workspace path by ID without changing the active workspace", async () => {
    const userDataPath = await temporaryDirectory()
    const catalog = new WorkspaceCatalog({ userDataPath })
    await catalog.upsertAndActivate({ id: "workspace-1", path: "/old/one" })
    await catalog.upsertAndActivate({ id: "workspace-2", path: "/wikis/two" })

    assert.equal(
      await catalog.repairWorkspacePath("workspace-1", "/moved/one"),
      true
    )
    assert.equal(
      await catalog.repairWorkspacePath("missing", "/moved/missing"),
      false
    )

    assert.deepEqual(await catalog.listWorkspaces(), [
      { id: "workspace-1", path: "/moved/one" },
      { id: "workspace-2", path: "/wikis/two" },
    ])
    assert.deepEqual(await catalog.findLastActiveWorkspace(), {
      id: "workspace-2",
      path: "/wikis/two",
    })
  })

  it("clears last-active without forgetting workspace records", async () => {
    const userDataPath = await temporaryDirectory()
    const catalog = new WorkspaceCatalog({ userDataPath })
    const record = { id: "workspace-1", path: "/wikis/one" }
    await catalog.upsertAndActivate(record)

    await catalog.clearLastActive()

    assert.equal(await catalog.findLastActiveWorkspace(), null)
    assert.deepEqual(await catalog.listWorkspaces(), [record])
  })

  it("forgets a record and clears its active marker without deleting workspace files", async () => {
    const userDataPath = await temporaryDirectory()
    const workspaceFile = join(userDataPath, "actual-workspace-file.md")
    await writeFile(workspaceFile, "keep me")
    const catalog = new WorkspaceCatalog({ userDataPath })
    await catalog.upsertAndActivate({
      id: "workspace-1",
      path: join(userDataPath, "actual-workspace"),
    })

    assert.equal(await catalog.forgetWorkspace("workspace-1"), true)
    assert.equal(await catalog.forgetWorkspace("workspace-1"), false)

    assert.deepEqual(await catalog.listWorkspaces(), [])
    assert.equal(await catalog.findLastActiveWorkspace(), null)
    assert.equal(await readFile(workspaceFile, "utf8"), "keep me")
  })

  it("treats malformed JSON as empty and replaces it on the next mutation", async () => {
    const userDataPath = await temporaryDirectory()
    await writeCatalog(userDataPath, "{ definitely not JSON")
    const catalog = new WorkspaceCatalog({ userDataPath })

    assert.deepEqual(await catalog.listWorkspaces(), [])
    assert.equal(await catalog.findLastActiveWorkspace(), null)

    await catalog.upsertAndActivate({ id: "workspace-1", path: "/wikis/one" })
    assert.deepEqual(JSON.parse(await catalogSource(userDataPath)), {
      version: 1,
      lastActiveWorkspaceId: "workspace-1",
      workspaces: [{ id: "workspace-1", path: "/wikis/one" }],
    })
  })

  for (const invalid of [
    {
      name: "unsupported version",
      value: { version: 2, lastActiveWorkspaceId: null, workspaces: [] },
    },
    {
      name: "blank last-active ID",
      value: { version: 1, lastActiveWorkspaceId: " ", workspaces: [] },
    },
    {
      name: "blank workspace ID",
      value: {
        version: 1,
        lastActiveWorkspaceId: null,
        workspaces: [{ id: "", path: "/wikis/one" }],
      },
    },
    {
      name: "blank workspace path",
      value: {
        version: 1,
        lastActiveWorkspaceId: null,
        workspaces: [{ id: "workspace-1", path: "\t" }],
      },
    },
    {
      name: "duplicate workspace IDs",
      value: {
        version: 1,
        lastActiveWorkspaceId: "workspace-1",
        workspaces: [
          { id: "workspace-1", path: "/wikis/one" },
          { id: "workspace-1", path: "/wikis/other" },
        ],
      },
    },
  ] satisfies Array<{ name: string; value: unknown }>) {
    it(`ignores invalid loaded schema: ${invalid.name}`, async () => {
      const userDataPath = await temporaryDirectory()
      await writeCatalog(userDataPath, JSON.stringify(invalid.value))
      const catalog = new WorkspaceCatalog({ userDataPath })

      assert.deepEqual(await catalog.listWorkspaces(), [])
      assert.equal(await catalog.findLastActiveWorkspace(), null)
    })
  }

  it("rejects nonblank input violations without persisting them", async () => {
    const userDataPath = await temporaryDirectory()
    const catalog = new WorkspaceCatalog({ userDataPath })

    await assert.rejects(
      catalog.upsertAndActivate({ id: " ", path: "/wikis/one" }),
      /Workspace ID must be a nonblank string/
    )
    await assert.rejects(
      catalog.upsertAndActivate({ id: "workspace-1", path: "" }),
      /Workspace path must be a nonblank string/
    )

    assert.deepEqual(await catalog.listWorkspaces(), [])
  })

  it("serializes concurrent mutations so no workspace update is lost", async () => {
    const userDataPath = await temporaryDirectory()
    const catalog = new WorkspaceCatalog({ userDataPath })

    await Promise.all([
      catalog.upsertAndActivate({ id: "workspace-1", path: "/wikis/one" }),
      catalog.upsertAndActivate({ id: "workspace-2", path: "/wikis/two" }),
    ])

    assert.deepEqual(await catalog.listWorkspaces(), [
      { id: "workspace-1", path: "/wikis/one" },
      { id: "workspace-2", path: "/wikis/two" },
    ])
    assert.deepEqual(await catalog.findLastActiveWorkspace(), {
      id: "workspace-2",
      path: "/wikis/two",
    })
  })

  it("keeps the previous catalog and cleans unique temp files when rename fails", async () => {
    const userDataPath = await temporaryDirectory()
    const original = new WorkspaceCatalog({ userDataPath })
    await original.upsertAndActivate({ id: "workspace-1", path: "/old/one" })
    const originalSource = await catalogSource(userDataPath)
    const temporaryPaths: string[] = []
    const catalog = new WorkspaceCatalog({
      userDataPath,
      rename: async (from) => {
        temporaryPaths.push(String(from))
        throw new Error("injected rename failure")
      },
    })

    await assert.rejects(
      catalog.repairWorkspacePath("workspace-1", "/new/one"),
      /injected rename failure/
    )
    await assert.rejects(
      catalog.repairWorkspacePath("workspace-1", "/another/one"),
      /injected rename failure/
    )

    assert.equal(await catalogSource(userDataPath), originalSource)
    assert.equal(temporaryPaths.length, 2)
    assert.notEqual(temporaryPaths[0], temporaryPaths[1])
    assert.ok(
      temporaryPaths.every(
        (path) =>
          path.startsWith(join(userDataPath, "workspaces", "catalog.json.")) &&
          path.endsWith(".tmp")
      )
    )
    assert.deepEqual(await readdir(join(userDataPath, "workspaces")), [
      "catalog.json",
    ])
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "amend-workspace-catalog-"))
  temporaryDirectories.push(directory)
  return directory
}

async function writeCatalog(userDataPath: string, source: string): Promise<void> {
  await mkdir(join(userDataPath, "workspaces"), { recursive: true })
  await writeFile(join(userDataPath, "workspaces", "catalog.json"), source)
}

async function catalogSource(userDataPath: string): Promise<string> {
  return await readFile(join(userDataPath, "workspaces", "catalog.json"), "utf8")
}
