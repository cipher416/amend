import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

import { createWikiEngine } from "./wiki-engine.ts"
import type { WikiAgent } from "./wiki-engine.ts"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("wiki engine", () => {
  it("commits first and subsequent source runs while preserving both", async () => {
    const parent = await mkdtemp(join(tmpdir(), "amend-wiki-engine-"))
    temporaryDirectories.push(parent)
    const workspacePath = join(parent, "wiki")
    const runIds = [
      "019f7910-0000-7000-8000-000000000001",
      "019f7910-0000-7000-8000-000000000002",
    ]
    const dates = ["2026-07-19T12:00:00.000Z", "2026-07-20T12:00:00.000Z"]
    const engine = createWikiEngine({
      agent: createFakeAgent(),
      createRunId: () => {
        const id = runIds.shift()
        if (!id) throw new Error("test exhausted run IDs")
        return id
      },
      now: () => {
        const date = dates.shift()
        if (!date) throw new Error("test exhausted dates")
        return new Date(date)
      },
    })
    const initialized = await engine.initialize({
      workspacePath,
      domain: "Distributed systems engineering",
    })
    expect(await readFile(join(workspacePath, "SCHEMA.md"), "utf8")).toContain(
      "Wikilinks reference wiki page slugs only"
    )

    const first = await engine.ingest({
      workspacePath,
      sources: [
        {
          path: "raw/articles/write-ahead-logging.md",
          content:
            "# Write-ahead logging\n\nA write-ahead log records mutations before data pages are changed.\n",
        },
      ],
    })
    const firstRaw = await readFile(
      join(workspacePath, "raw/articles/write-ahead-logging.md"),
      "utf8"
    )
    const second = await engine.ingest({
      workspacePath,
      sources: [
        {
          path: "raw/articles/checkpointing.md",
          content:
            "# Checkpointing\n\nA checkpoint bounds recovery work by persisting a known durable state.\n",
        },
      ],
    })

    expect(first.baseCommit).toBe(initialized.commitHash)
    expect(second.baseCommit).toBe(first.commitHash)
    expect(second.commitHash).not.toBe(first.commitHash)
    expect(await git(workspacePath, "rev-parse", "HEAD")).toBe(
      second.commitHash
    )
    expect(await git(workspacePath, "rev-parse", `${second.commitHash}^`)).toBe(
      first.commitHash
    )
    expect(
      await readFile(
        join(workspacePath, "raw/articles/write-ahead-logging.md"),
        "utf8"
      )
    ).toBe(firstRaw)
    expect(
      await readFile(
        join(workspacePath, "concepts/write-ahead-logging.md"),
        "utf8"
      )
    ).toMatch(/\[\[checkpointing\]\]/)
    expect(
      await readFile(join(workspacePath, "concepts/checkpointing.md"), "utf8")
    ).toMatch(/raw\/articles\/checkpointing\.md/)
    expect(await readFile(join(workspacePath, "index.md"), "utf8")).toMatch(
      /\[\[write-ahead-logging\]\].*\[\[checkpointing\]\]/s
    )
    expect(
      await readFile(
        join(workspacePath, `.amend/runs/${first.runId}.json`),
        "utf8"
      )
    ).toMatch(new RegExp(`"baseCommit": "${initialized.commitHash}"`))
    expect(
      await git(workspacePath, "show", "-s", "--format=%B", second.commitHash)
    ).toMatch(new RegExp(`Amend-Run: ${second.runId}`))
    expect(await git(workspacePath, "status", "--porcelain")).toBe("")
  })

  it("rejects a later run that modifies an earlier raw source", async () => {
    const parent = await mkdtemp(join(tmpdir(), "amend-wiki-engine-"))
    temporaryDirectories.push(parent)
    const workspacePath = join(parent, "wiki")
    const fakeAgent = createFakeAgent()
    let run = 0
    const agent: WikiAgent = {
      name: fakeAgent.name,
      async run(input) {
        run += 1
        const result = await fakeAgent.run(input)
        if (run === 2) {
          await writeFile(
            join(input.workspacePath, "raw/articles/write-ahead-logging.md"),
            "tampered\n"
          )
        }
        return result
      },
    }
    const engine = createWikiEngine({ agent })
    await engine.initialize({
      workspacePath,
      domain: "Distributed systems engineering",
    })
    const first = await engine.ingest({
      workspacePath,
      sources: [
        {
          path: "raw/articles/write-ahead-logging.md",
          content:
            "# Write-ahead logging\n\nA write-ahead log records mutations before data pages are changed.\n",
        },
      ],
    })
    const originalRaw = await readFile(
      join(workspacePath, "raw/articles/write-ahead-logging.md"),
      "utf8"
    )

    await expect(
      engine.ingest({
        workspacePath,
        sources: [
          {
            path: "raw/articles/checkpointing.md",
            content: "# Checkpointing\n\nA checkpoint bounds recovery work.\n",
          },
        ],
      })
    ).rejects.toThrow("modified immutable raw source")
    expect(await git(workspacePath, "rev-parse", "HEAD")).toBe(first.commitHash)
    expect(
      await readFile(
        join(workspacePath, "raw/articles/write-ahead-logging.md"),
        "utf8"
      )
    ).toBe(originalRaw)
    expect(await git(workspacePath, "status", "--porcelain")).toBe("")
  })

  it("reports all deterministic lint diagnostics to the agent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "amend-wiki-engine-"))
    temporaryDirectories.push(parent)
    const workspacePath = join(parent, "wiki")
    let reportedCodes: string[] = []
    const agent: WikiAgent = {
      name: "fake/invalid-agent",
      async run(input) {
        await writeFile(
          join(input.workspacePath, "concepts/write-ahead-logging.md"),
          `---
title: Write-ahead logging
created: 2026-07-19
updated: 2026-07-19
type: concept
tags: [storage]
sources: [raw/articles/write-ahead-logging.md]
---

# Write-ahead logging

See [[missing-page]].
`
        )
        const logPath = join(input.workspacePath, "log.md")
        await writeFile(
          logPath,
          `${await readFile(logPath, "utf8")}\n## [2026-07-19] ingest | Invalid run\n`
        )
        reportedCodes = (await input.lint()).map(({ code }) => code)
        return { summary: "Invalid run" }
      },
    }
    const engine = createWikiEngine({ agent })
    await engine.initialize({
      workspacePath,
      domain: "Distributed systems engineering",
    })

    await expect(
      engine.ingest({
        workspacePath,
        sources: [
          {
            path: "raw/articles/write-ahead-logging.md",
            content: "# Write-ahead logging\n",
          },
        ],
      })
    ).rejects.toThrow("Wiki lint failed")
    expect(reportedCodes).toEqual(
      expect.arrayContaining(["index.missing-page", "wikilink.broken"])
    )
  })

  it("preserves primary-worktree edits made during an ingest", async () => {
    const parent = await mkdtemp(join(tmpdir(), "amend-wiki-engine-"))
    temporaryDirectories.push(parent)
    const workspacePath = join(parent, "wiki")
    const fakeAgent = createFakeAgent()
    const userEdit = "# User edit made during ingest\n"
    const agent: WikiAgent = {
      name: fakeAgent.name,
      async run(input) {
        const result = await fakeAgent.run(input)
        await writeFile(join(workspacePath, "index.md"), userEdit)
        return result
      },
    }
    const engine = createWikiEngine({ agent })
    const initialized = await engine.initialize({
      workspacePath,
      domain: "Distributed systems engineering",
    })

    await expect(
      engine.ingest({
        workspacePath,
        sources: [
          {
            path: "raw/articles/write-ahead-logging.md",
            content: "# Write-ahead logging\n",
          },
        ],
      })
    ).rejects.toThrow("Wiki workspace changed during ingest")
    expect(await readFile(join(workspacePath, "index.md"), "utf8")).toBe(
      userEdit
    )
    expect(await git(workspacePath, "rev-parse", "HEAD")).toBe(
      initialized.commitHash
    )
  })

  it("recovers an ingest lock left by a terminated process", async () => {
    const parent = await mkdtemp(join(tmpdir(), "amend-wiki-engine-"))
    temporaryDirectories.push(parent)
    const workspacePath = join(parent, "wiki")
    const engine = createWikiEngine({ agent: createFakeAgent() })
    await engine.initialize({
      workspacePath,
      domain: "Distributed systems engineering",
    })
    await writeFile(
      join(workspacePath, ".git/amend-run.lock"),
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: "stale-lock",
        createdAt: new Date().toISOString(),
      })}\n`
    )

    await expect(
      engine.ingest({
        workspacePath,
        sources: [
          {
            path: "raw/articles/write-ahead-logging.md",
            content: "# Write-ahead logging\n",
          },
        ],
      })
    ).resolves.toMatchObject({ summary: "Integrated source run 1" })
  })
})

function createFakeAgent(): WikiAgent {
  let run = 0

  return {
    name: "fake/wiki-agent",
    async run({ workspacePath }) {
      run += 1

      if (run === 1) {
        await writeFile(
          join(workspacePath, "concepts/write-ahead-logging.md"),
          `---
title: Write-ahead logging
created: 2026-07-19
updated: 2026-07-19
type: concept
tags: [storage]
sources:
  - raw/articles/write-ahead-logging.md
confidence: medium
---

# Write-ahead logging

A write-ahead log records mutations before data pages are changed.
`
        )
        await writeFile(
          join(workspacePath, "index.md"),
          "# Wiki Index\n\n## Concepts\n\n- [[write-ahead-logging]] - Records changes before data pages.\n"
        )
      } else {
        await writeFile(
          join(workspacePath, "concepts/write-ahead-logging.md"),
          `---
title: Write-ahead logging
created: 2026-07-19
updated: 2026-07-20
type: concept
tags: [storage]
sources: [raw/articles/write-ahead-logging.md]
confidence: medium
---

# Write-ahead logging

A write-ahead log records mutations before data pages are changed.

See [[checkpointing]] for bounding recovery work.
`
        )
        await writeFile(
          join(workspacePath, "concepts/checkpointing.md"),
          `---
title: Checkpointing
created: 2026-07-20
updated: 2026-07-20
type: concept
tags: [storage]
sources: [raw/articles/checkpointing.md]
confidence: medium
---

# Checkpointing

A checkpoint bounds recovery work by persisting a known durable state.

Checkpointing complements [[write-ahead-logging]].
`
        )
        await writeFile(
          join(workspacePath, "index.md"),
          "# Wiki Index\n\n## Concepts\n\n- [[write-ahead-logging]] - Records changes before data pages.\n- [[checkpointing]] - Bounds recovery work with durable state.\n"
        )
      }

      const logPath = join(workspacePath, "log.md")
      const log = await readFile(logPath, "utf8")
      await writeFile(
        logPath,
        `${log}\n## [2026-07-${run === 1 ? "19" : "20"}] ingest | Run ${run}\n`
      )

      return { summary: `Integrated source run ${run}` }
    },
  }
}

async function git(rootPath: string, ...arguments_: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", rootPath, ...arguments_])
  return result.stdout.trim()
}
