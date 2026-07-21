import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "vitest"

import { WikiHome } from "./wiki-home.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("wiki home", () => {
  it("reads the existing home state and derives its sibling wiki directory", async () => {
    const userDataPath = await temporaryDirectory()
    const parentPath = join(userDataPath, "knowledge")
    const home = new WikiHome({ userDataPath })

    await home.setParentPath(parentPath)

    assert.deepEqual(
      JSON.parse(await readFile(join(userDataPath, "wikis/home.json"), "utf8")),
      { version: 1, parentPath, lastActiveWikiId: null }
    )

    assert.deepEqual(await new WikiHome({ userDataPath }).read(), {
      parentPath,
      wikiDirectory: parentPath,
      lastActiveWikiId: null,
    })
  })

  it("remembers the last active wiki without changing the selected parent", async () => {
    const userDataPath = await temporaryDirectory()
    const parentPath = join(userDataPath, "knowledge")
    const home = new WikiHome({ userDataPath })
    await home.setParentPath(parentPath)

    await home.setLastActiveWikiId("wiki-123")

    assert.deepEqual(await home.read(), {
      parentPath,
      wikiDirectory: parentPath,
      lastActiveWikiId: "wiki-123",
    })
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "amend-wiki-home-"))
  temporaryDirectories.push(directory)
  return directory
}
