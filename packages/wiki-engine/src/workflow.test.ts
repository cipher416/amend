import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { openWikiIndex } from "./index/index.ts"
import { createWikiEngine } from "./ingest/index.ts"
import type { WikiAgent } from "./ingest/index.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("first source workflow", () => {
  it("initializes, ingests, refreshes, and searches the committed page", async () => {
    const parent = await mkdtemp(join(tmpdir(), "amend-workflow-"))
    temporaryDirectories.push(parent)
    const workspacePath = join(parent, "reliability-wiki")
    const engine = createWikiEngine({
      agent: createFirstSourceAgent(),
      createRunId: () => "019f7910-0000-7000-8000-000000000001",
      now: () => new Date("2026-07-19T12:00:00.000Z"),
    })

    await engine.initialize({
      workspacePath,
      domain: "Database reliability engineering",
    })
    const ingest = await engine.ingest({
      workspacePath,
      sources: [
        {
          path: "raw/articles/write-ahead-logging.md",
          title: "Write-ahead logging field notes",
          content:
            "# Write-ahead logging\n\nA WAL makes crash recovery possible by recording mutations before data pages change.\n",
        },
      ],
      instruction: "Capture why ordering is important for crash recovery.",
    })
    expect(
      await readFile(
        join(workspacePath, "raw/articles/write-ahead-logging.md"),
        "utf8"
      )
    ).toContain('title: "Write-ahead logging field notes"')
    const index = await openWikiIndex({
      workspacePath,
      databasePath: join(parent, "indexes", "wiki.sqlite"),
    })

    try {
      const refresh = await index.refresh()
      const results = await index.search({
        query: "crash recovery",
        scope: "pages",
      })
      const sources = await index.search({
        query: "recording mutations",
        scope: "sources",
      })

      expect(refresh.commitHash).toBe(ingest.commitHash)
      expect(refresh.added).toBeGreaterThan(0)
      expect(results[0]).toMatchObject({
        kind: "page",
        path: "concepts/write-ahead-logging.md",
        title: "Write-ahead logging",
      })
      expect(results[0]?.snippet).toContain("crash recovery")
      expect(sources[0]?.title).toBe("Write-ahead logging field notes")
    } finally {
      await index.close()
    }
  })
})

function createFirstSourceAgent(): WikiAgent {
  return {
    name: "fake/first-source-agent",
    async run({ workspacePath, prompt }) {
      expect(prompt).toContain(
        "Capture why ordering is important for crash recovery."
      )
      await writeFile(
        join(workspacePath, "concepts/write-ahead-logging.md"),
        `---
title: Write-ahead logging
created: 2026-07-19
updated: 2026-07-19
type: concept
tags: [database-reliability, storage]
sources: [raw/articles/write-ahead-logging.md]
---

# Write-ahead logging

A write-ahead log preserves mutation order so crash recovery can reconstruct a durable state.
`
      )
      await writeFile(
        join(workspacePath, "index.md"),
        "# Wiki Index\n\n## Concepts\n\n- [[write-ahead-logging]] - Preserves mutation order for crash recovery.\n"
      )
      const logPath = join(workspacePath, "log.md")
      const log = await readFile(logPath, "utf8")
      await writeFile(
        logPath,
        `${log}\n## [2026-07-19] ingest | Write-ahead logging\n- Created concepts/write-ahead-logging.md\n`
      )
      return { summary: "Added write-ahead logging" }
    },
  }
}
