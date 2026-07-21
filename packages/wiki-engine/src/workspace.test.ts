import { execFile } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import {
  migrateWorkspace,
  readWorkspace,
} from "@workspace/wiki-engine/workspace"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("workspace", () => {
  it("reads a strictly valid v2 manifest without changing the workspace", async () => {
    const workspacePath = await createWorkspace({
      version: 2,
      id: "123e4567-e89b-42d3-a456-426614174000",
      domain: "Distributed systems",
    })
    const manifestPath = join(workspacePath, ".amend/workspace.json")
    const originalManifest = await readFile(manifestPath, "utf8")
    const originalHead = await git(workspacePath, "rev-parse", "HEAD")

    await expect(readWorkspace({ workspacePath })).resolves.toEqual({
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

    await expect(readWorkspace({ workspacePath })).resolves.toMatchObject({
      setupStatus: "initialized",
    })

    await git(workspacePath, "add", "--", ".amend/runs/run-1.json")
    await git(workspacePath, "commit", "-m", "Record first run")

    await expect(readWorkspace({ workspacePath })).resolves.toMatchObject({
      setupStatus: "ready",
    })
  })

  it.each([
    ["legacy version", { version: 1, domain: "Distributed systems" }],
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

    await expect(readWorkspace({ workspacePath })).rejects.toThrow(
      "Invalid wiki workspace manifest"
    )
  })

  it("validates that the workspace is the main Git root", async () => {
    const workspacePath = await createWorkspace({
      version: 2,
      id: "123e4567-e89b-42d3-a456-426614174000",
      domain: "Distributed systems",
    })
    await git(workspacePath, "switch", "-c", "other")

    await expect(readWorkspace({ workspacePath })).rejects.toThrow(
      "Wiki workspace must use the main branch"
    )
    await expect(
      readWorkspace({ workspacePath: join(workspacePath, ".amend") })
    ).rejects.toThrow("Wiki workspace must be the Git repository root")
  })

  it("migrates a clean v1 workspace using its local Git identity", async () => {
    const workspacePath = await createWorkspace({
      version: 1,
      domain: "Distributed systems",
    })
    const previousHead = await git(workspacePath, "rev-parse", "HEAD")

    await expect(
      migrateWorkspace({
        workspacePath,
        createWorkspaceId: () => "123e4567-e89b-42d3-a456-426614174000",
      })
    ).resolves.toEqual({
      id: "123e4567-e89b-42d3-a456-426614174000",
      domain: "Distributed systems",
      setupStatus: "initialized",
    })
    await expect(readWorkspace({ workspacePath })).resolves.toEqual({
      id: "123e4567-e89b-42d3-a456-426614174000",
      domain: "Distributed systems",
      setupStatus: "initialized",
    })
    expect(await git(workspacePath, "rev-parse", "HEAD^")).toBe(previousHead)
    expect(await git(workspacePath, "show", "-s", "--format=%an <%ae>")).toBe(
      "Amend Test <test@example.invalid>"
    )
    expect(await git(workspacePath, "show", "-s", "--format=%s")).toBe(
      "Migrate workspace metadata"
    )
    expect(await git(workspacePath, "status", "--porcelain")).toBe("")
  })

  it("preserves ready status through the metadata migration commit", async () => {
    const workspacePath = await createWorkspace({
      version: 1,
      domain: "Distributed systems",
    })
    await mkdir(join(workspacePath, ".amend/runs"))
    await writeFile(join(workspacePath, ".amend/runs/run-1.json"), "{}\n")
    await git(workspacePath, "add", "--", ".amend/runs/run-1.json")
    await git(workspacePath, "commit", "-m", "Record first run")

    await expect(
      migrateWorkspace({
        workspacePath,
        createWorkspaceId: () => "123e4567-e89b-42d3-a456-426614174000",
      })
    ).resolves.toEqual({
      id: "123e4567-e89b-42d3-a456-426614174000",
      domain: "Distributed systems",
      setupStatus: "ready",
    })
    await expect(readWorkspace({ workspacePath })).resolves.toMatchObject({
      setupStatus: "ready",
    })
  })

  it("requires a clean repository before migrating", async () => {
    const workspacePath = await createWorkspace({
      version: 1,
      domain: "Distributed systems",
    })
    const manifestPath = join(workspacePath, ".amend/workspace.json")
    const originalManifest = await readFile(manifestPath, "utf8")
    await writeFile(join(workspacePath, "notes.md"), "uncommitted\n")

    await expect(migrateWorkspace({ workspacePath })).rejects.toThrow(
      "Wiki workspace must be clean before migration"
    )
    expect(await readFile(manifestPath, "utf8")).toBe(originalManifest)
  })

  it("restores the v1 manifest when the migration commit fails", async () => {
    const workspacePath = await createWorkspace({
      version: 1,
      domain: "Distributed systems",
    })
    const manifestPath = join(workspacePath, ".amend/workspace.json")
    const originalManifest = await readFile(manifestPath, "utf8")
    const originalHead = await git(workspacePath, "rev-parse", "HEAD")
    const hookPath = join(workspacePath, ".git/hooks/pre-commit")
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n")
    await chmod(hookPath, 0o755)
    await git(workspacePath, "config", "core.hooksPath", ".git/hooks")

    await expect(
      migrateWorkspace({
        workspacePath,
        createWorkspaceId: () => "123e4567-e89b-42d3-a456-426614174000",
      })
    ).rejects.toThrow()
    expect(await readFile(manifestPath, "utf8")).toBe(originalManifest)
    expect(await git(workspacePath, "rev-parse", "HEAD")).toBe(originalHead)
    expect(await git(workspacePath, "status", "--porcelain")).toBe("")
  })
})

async function createWorkspace(manifest: unknown): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), "amend-metadata-"))
  temporaryDirectories.push(workspacePath)
  await mkdir(join(workspacePath, ".amend"))
  await writeFile(
    join(workspacePath, ".amend/workspace.json"),
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
