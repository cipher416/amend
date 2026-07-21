import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "vitest"

import { WorkspaceHome } from "./workspace-home.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("workspace home", () => {
  it("persists the selected parent and derives its sibling workspace directory", async () => {
    const userDataPath = await temporaryDirectory()
    const parentPath = join(userDataPath, "knowledge")
    const home = new WorkspaceHome({ userDataPath })

    await home.setParentPath(parentPath)

    assert.deepEqual(await new WorkspaceHome({ userDataPath }).read(), {
      parentPath,
      workspaceDirectory: parentPath,
      lastActiveWorkspaceId: null,
    })
  })

  it("remembers the last active workspace without changing the selected parent", async () => {
    const userDataPath = await temporaryDirectory()
    const parentPath = join(userDataPath, "knowledge")
    const home = new WorkspaceHome({ userDataPath })
    await home.setParentPath(parentPath)

    await home.setLastActiveWorkspaceId("workspace-123")

    assert.deepEqual(await home.read(), {
      parentPath,
      workspaceDirectory: parentPath,
      lastActiveWorkspaceId: "workspace-123",
    })
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "amend-workspace-home-"))
  temporaryDirectories.push(directory)
  return directory
}
