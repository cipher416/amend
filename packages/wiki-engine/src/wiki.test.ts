import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { readWiki } from "@workspace/wiki-engine/wiki"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("wiki", () => {
  it("reads a strictly valid v2 manifest without changing the wiki", async () => {
    const workspacePath = await createWorkspace({
      version: 2,
      id: "123e4567-e89b-42d3-a456-426614174000",
      domain: "Distributed systems",
    })
    const manifestPath = join(workspacePath, ".amend/wiki.json")
    const originalManifest = await readFile(manifestPath, "utf8")
    const originalHead = await git(workspacePath, "rev-parse", "HEAD")

    await expect(readWiki({ wikiPath: workspacePath })).resolves.toEqual({
      id: "123e4567-e89b-42d3-a456-426614174000",
      domain: "Distributed systems",
      setupStatus: "initialized",
    })
    expect(await readFile(manifestPath, "utf8")).toBe(originalManifest)
    expect(await git(workspacePath, "rev-parse", "HEAD")).toBe(originalHead)
    expect(await git(workspacePath, "status", "--porcelain")).toBe("")
  })

  it("becomes ready only after a run record is committed", async () => {
    const workspacePath = await createWorkspace({
      version: 2,
      id: "123e4567-e89b-42d3-a456-426614174000",
      domain: "Distributed systems",
    })
    await mkdir(join(workspacePath, ".amend/runs"))
    await writeFile(join(workspacePath, ".amend/runs/run-1.json"), "{}\n")

    await expect(readWiki({ wikiPath: workspacePath })).resolves.toMatchObject({
      setupStatus: "initialized",
    })

    await git(workspacePath, "add", "--", ".amend/runs/run-1.json")
    await git(workspacePath, "commit", "-m", "Record first run")

    await expect(readWiki({ wikiPath: workspacePath })).resolves.toMatchObject({
      setupStatus: "ready",
    })
  })

  it.each([
    [
      "unknown field",
      {
        version: 2,
        id: "123e4567-e89b-42d3-a456-426614174000",
        domain: "Distributed systems",
        path: "/private/wiki",
      },
    ],
    [
      "invalid ID",
      { version: 2, id: "workspace-1", domain: "Distributed systems" },
    ],
    [
      "untrimmed domain",
      {
        version: 2,
        id: "123e4567-e89b-42d3-a456-426614174000",
        domain: " Distributed systems ",
      },
    ],
  ])("rejects a manifest with %s", async (_label, manifest) => {
    const workspacePath = await createWorkspace(manifest)

    await expect(readWiki({ wikiPath: workspacePath })).rejects.toThrow(
      "Invalid wiki manifest"
    )
  })

  it("validates that the wiki is the main Git root", async () => {
    const workspacePath = await createWorkspace({
      version: 2,
      id: "123e4567-e89b-42d3-a456-426614174000",
      domain: "Distributed systems",
    })
    await git(workspacePath, "switch", "-c", "other")

    await expect(readWiki({ wikiPath: workspacePath })).rejects.toThrow(
      "Wiki must use the main branch"
    )
    await expect(
      readWiki({ wikiPath: join(workspacePath, ".amend") })
    ).rejects.toThrow("Wiki must be the Git repository root")
  })
})

async function createWorkspace(manifest: unknown): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), "amend-metadata-"))
  temporaryDirectories.push(workspacePath)
  await mkdir(join(workspacePath, ".amend"))
  await writeFile(
    join(workspacePath, ".amend/wiki.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  await git(workspacePath, "init", "--initial-branch=main")
  await git(workspacePath, "config", "user.name", "Amend Test")
  await git(workspacePath, "config", "user.email", "test@example.invalid")
  await git(workspacePath, "config", "commit.gpgsign", "false")
  await git(workspacePath, "add", "--all")
  await git(workspacePath, "commit", "-m", "Initialize test wiki")
  return workspacePath
}

async function git(rootPath: string, ...arguments_: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", rootPath, ...arguments_])
  return result.stdout.trim()
}
