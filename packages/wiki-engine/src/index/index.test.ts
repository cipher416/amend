import { execFile } from "node:child_process"
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

import { openWikiIndex } from "@workspace/wiki-engine/index"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("wiki index", () => {
  it("indexes and searches committed wiki pages and raw sources", async () => {
    const parent = await createWikiWorkspace()
    const workspacePath = join(parent, "wiki")
    const index = await openWikiIndex({
      workspacePath,
      databasePath: join(parent, "index.sqlite"),
    })

    await expect(index.refresh()).resolves.toMatchObject({
      added: 2,
      updated: 0,
      removed: 0,
      unchanged: 0,
    })
    await expect(index.listTags()).resolves.toEqual([
      { tag: "distributed-systems", count: 1 },
      { tag: "storage", count: 1 },
    ])

    const pageResults = await index.search({
      query: "recovery durability",
      scope: "pages",
      pageTypes: ["concept"],
      tags: ["distributed-systems", "storage"],
    })
    expect(pageResults).toHaveLength(1)
    expect(pageResults[0]).toMatchObject({
      kind: "page",
      path: "concepts/write-ahead-logging.md",
      title: "Write-ahead logging",
      pageType: "concept",
      tags: ["distributed-systems", "storage"],
      heading: "Recovery",
    })
    expect(pageResults[0]?.snippet).toContain("durability")
    expect(pageResults[0]?.snippet).not.toContain("https://example.com")
    expect(pageResults[0]?.highlights.length).toBeGreaterThan(0)
    await expect(
      index.search({
        query: "recovery",
        tags: ["distributed-systems", "missing-tag"],
      })
    ).resolves.toEqual([])
    const titleResults = await index.search({
      query: "write-ahead",
      scope: "pages",
    })
    expect(titleResults).toHaveLength(1)
    expect(titleResults[0]?.snippet.toLowerCase()).toContain("write-ahead")
    expect(titleResults[0]?.highlights.length).toBeGreaterThan(0)
    await expect(
      index.search({ query: "write_ahead", scope: "pages" })
    ).resolves.toHaveLength(1)

    await expect(
      index.search({ query: "mutation record", scope: "sources" })
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "source",
        path: "raw/articles/write-ahead-logging.md",
        title: "Write-ahead logging",
        tags: [],
      }),
    ])

    await index.close()
  })

  it("incrementally replaces changed documents and removes deleted ones", async () => {
    const parent = await createWikiWorkspace()
    const workspacePath = join(parent, "wiki")
    const index = await openWikiIndex({
      workspacePath,
      databasePath: join(parent, "index.sqlite"),
    })
    await index.refresh()

    await expect(index.refresh()).resolves.toMatchObject({
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 2,
    })
    await writeFile(
      join(workspacePath, "concepts/write-ahead-logging.md"),
      `---
title: Write-ahead logging
created: 2026-07-19
updated: 2026-07-20
type: concept
tags: [recovery, storage]
sources: [raw/articles/write-ahead-logging.md]
---

# Write-ahead logging

## Redo protocol

The redo protocol restores committed changes after a crash.
`
    )
    await git(workspacePath, "add", "--all")
    await git(workspacePath, "commit", "-m", "Update recovery page")

    await expect(index.refresh()).resolves.toMatchObject({
      added: 0,
      updated: 1,
      removed: 0,
      unchanged: 1,
    })
    await expect(index.search({ query: "durability" })).resolves.toEqual([])
    await expect(index.search({ query: "redo protocol" })).resolves.toEqual([
      expect.objectContaining({
        path: "concepts/write-ahead-logging.md",
        heading: "Redo protocol",
        tags: ["recovery", "storage"],
      }),
    ])

    await rm(join(workspacePath, "raw/articles/write-ahead-logging.md"))
    await rm(join(workspacePath, "concepts/write-ahead-logging.md"))
    await git(workspacePath, "add", "--all")
    await git(workspacePath, "commit", "-m", "Remove raw source")
    await expect(index.refresh()).resolves.toMatchObject({
      added: 0,
      updated: 0,
      removed: 2,
      unchanged: 0,
    })
    await expect(index.search({ query: "mutation record" })).resolves.toEqual(
      []
    )
    await index.close()
  })

  it("rejects dirty worktrees and unsafe queries", async () => {
    const parent = await createWikiWorkspace()
    const workspacePath = join(parent, "wiki")
    const index = await openWikiIndex({
      workspacePath,
      databasePath: join(parent, "index.sqlite"),
    })
    await index.refresh()

    await expect(
      index.search({ query: "recovery OR body:* NEAR(" })
    ).resolves.toEqual([])
    await expect(index.search({ query: "***" })).rejects.toMatchObject({
      code: "invalid-query",
    })
    await expect(
      index.search({ query: "recovery", limit: 101 })
    ).rejects.toMatchObject({ code: "invalid-query" })

    await writeFile(join(workspacePath, "notes.md"), "uncommitted\n")
    await expect(index.refresh()).rejects.toMatchObject({
      code: "invalid-wiki",
    })
    await rm(join(workspacePath, "notes.md"))
    await git(workspacePath, "switch", "-c", "other")
    await expect(index.refresh()).rejects.toMatchObject({
      code: "invalid-wiki",
    })
    await index.close()
  })

  it("keeps the previous index when a source citation becomes invalid", async () => {
    const parent = await createWikiWorkspace()
    const workspacePath = join(parent, "wiki")
    const index = await openWikiIndex({
      workspacePath,
      databasePath: join(parent, "index.sqlite"),
    })
    const firstRefresh = await index.refresh()
    await rm(join(workspacePath, "raw/articles/write-ahead-logging.md"))
    await git(workspacePath, "add", "--all")
    await git(workspacePath, "commit", "-m", "Remove cited source")

    await expect(index.refresh()).rejects.toMatchObject({
      code: "refresh-failed",
    })
    await expect(
      index.search({ query: "recovery durability" })
    ).resolves.toHaveLength(1)
    await index.close()

    const reopened = await openWikiIndex({
      workspacePath,
      databasePath: join(parent, "index.sqlite"),
    })
    await expect(
      reopened.search({ query: "recovery durability" })
    ).resolves.toHaveLength(1)
    expect(firstRefresh.commitHash).not.toBe(
      await git(workspacePath, "rev-parse", "HEAD")
    )
    await reopened.close()
  })

  it("keeps database ownership and lifecycle explicit", async () => {
    const firstParent = await createWikiWorkspace()
    const firstWorkspacePath = join(firstParent, "wiki")
    const databasePath = join(firstParent, "index.sqlite")
    const index = await openWikiIndex({
      workspacePath: firstWorkspacePath,
      databasePath,
    })
    await index.refresh()
    await index.close()
    await index.close()
    await expect(index.search({ query: "recovery" })).rejects.toMatchObject({
      code: "closed",
    })

    const secondParent = await createWikiWorkspace()
    await expect(
      openWikiIndex({
        workspacePath: join(secondParent, "wiki"),
        databasePath,
      })
    ).rejects.toMatchObject({ code: "invalid-database" })
    await expect(
      openWikiIndex({
        workspacePath: firstWorkspacePath,
        databasePath: join(firstWorkspacePath, ".amend/index.sqlite"),
      })
    ).rejects.toMatchObject({ code: "invalid-database" })
  })

  it("retries when another index instance advances the same database", async () => {
    const parent = await createWikiWorkspace()
    const options = {
      workspacePath: join(parent, "wiki"),
      databasePath: join(parent, "index.sqlite"),
    }
    const first = await openWikiIndex(options)
    const second = await openWikiIndex(options)

    const refreshes = await Promise.all([first.refresh(), second.refresh()])
    expect(refreshes).toEqual([
      expect.objectContaining({ commitHash: refreshes[0].commitHash }),
      expect.objectContaining({ commitHash: refreshes[0].commitHash }),
    ])
    await expect(first.search({ query: "durability" })).resolves.toHaveLength(1)
    await expect(
      second.search({ query: "mutation record" })
    ).resolves.toHaveLength(1)
    await first.close()
    await second.close()
  })

  it("ranks title matches above body-only matches", async () => {
    const parent = await createWikiWorkspace()
    const workspacePath = join(parent, "wiki")
    await writeFile(
      join(workspacePath, "concepts/recovery-architecture.md"),
      `---
title: Recovery architecture
created: 2026-07-19
updated: 2026-07-19
type: concept
tags: [distributed-systems]
sources: [raw/articles/write-ahead-logging.md]
---

# Recovery architecture

This page mentions write-ahead logging only in its body.
`
    )
    await git(workspacePath, "add", "--all")
    await git(workspacePath, "commit", "-m", "Add recovery architecture")
    const index = await openWikiIndex({
      workspacePath,
      databasePath: join(parent, "index.sqlite"),
    })
    await index.refresh()

    const results = await index.search({
      query: "write-ahead logging",
      scope: "pages",
    })
    expect(results.map(({ path }) => path)).toEqual([
      "concepts/write-ahead-logging.md",
      "concepts/recovery-architecture.md",
    ])
    await index.close()
  })

  it.skipIf(process.platform === "win32")(
    "rejects in-worktree names and dangling symlink escapes",
    async () => {
      const parent = await createWikiWorkspace()
      const workspacePath = join(parent, "wiki")
      await expect(
        openWikiIndex({
          workspacePath,
          databasePath: join(workspacePath, "..index.sqlite"),
        })
      ).rejects.toMatchObject({ code: "invalid-database" })

      const target = join(workspacePath, ".amend/dangling-index.sqlite")
      const link = join(parent, "outside-index.sqlite")
      await symlink(target, link)
      await expect(
        openWikiIndex({ workspacePath, databasePath: link })
      ).rejects.toMatchObject({ code: "invalid-database" })
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" })
    }
  )
})

async function createWikiWorkspace(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "amend-wiki-index-"))
  temporaryDirectories.push(parent)
  const workspacePath = join(parent, "wiki")
  await Promise.all([
    mkdir(join(workspacePath, ".amend"), { recursive: true }),
    mkdir(join(workspacePath, "concepts"), { recursive: true }),
    mkdir(join(workspacePath, "raw/articles"), { recursive: true }),
  ])
  await Promise.all([
    writeFile(
      join(workspacePath, ".amend/wiki.json"),
      `${JSON.stringify({
        version: 2,
        id: "123e4567-e89b-42d3-a456-426614174000",
        domain: "Distributed systems",
      })}\n`
    ),
    writeFile(
      join(workspacePath, "concepts/write-ahead-logging.md"),
      `---
title: Write-ahead logging
created: 2026-07-19
updated: 2026-07-19
type: concept
tags: [distributed-systems, storage]
sources: [raw/articles/write-ahead-logging.md]
---

# Write-ahead logging

A write-ahead log records mutations before data pages change.
The implementation may call its durable record \`write_ahead\`.

## Recovery

Recovery replays the log to restore [durability](https://example.com/durability) after a crash.
`
    ),
    writeFile(
      join(workspacePath, "raw/articles/write-ahead-logging.md"),
      `---
ingested: 2026-07-19
sha256: abc123
---

\`\`\`markdown
# Not the source title
\`\`\`

Write-ahead logging
===================

A mutation record is persisted before the affected data page.
`
    ),
  ])
  await git(workspacePath, "init", "--initial-branch=main")
  await git(workspacePath, "config", "user.name", "Amend Test")
  await git(workspacePath, "config", "user.email", "test@example.invalid")
  await git(workspacePath, "add", "--all")
  await git(workspacePath, "commit", "-m", "Initialize test wiki")
  return parent
}

async function git(rootPath: string, ...arguments_: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", rootPath, ...arguments_])
  return result.stdout.trim()
}
