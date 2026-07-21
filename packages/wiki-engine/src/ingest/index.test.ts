import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

import { createWikiEngine } from "./index.ts"
import type { WikiAgent } from "./index.ts"

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
      createWikiId: () => "123e4567-e89b-42d3-a456-426614174000",
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
    expect(await readFile(join(workspacePath, "SCHEMA.md"), "utf8")).toContain(
      "Tags are open-ended; there is no fixed taxonomy"
    )
    expect(initialized.id).toBe("123e4567-e89b-42d3-a456-426614174000")
    expect(
      JSON.parse(
        await readFile(join(workspacePath, ".amend/wiki.json"), "utf8")
      )
    ).toEqual({
      version: 2,
      id: initialized.id,
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

  it("rejects changes to linked-worktree Git metadata", async () => {
    const parent = await mkdtemp(join(tmpdir(), "amend-wiki-engine-"))
    temporaryDirectories.push(parent)
    const workspacePath = join(parent, "wiki")
    const engine = createWikiEngine({
      agent: {
        name: "fake/git-metadata-writer",
        async run({ workspacePath: worktreePath }) {
          await writeFile(
            join(worktreePath, ".git"),
            "gitdir: /tmp/agent-controlled\n"
          )
          return { summary: "Modified Git metadata" }
        },
      },
      createRunId: () => "019f7910-0000-7000-8000-000000000001",
      now: () => new Date("2026-07-19T12:00:00.000Z"),
    })
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
    ).rejects.toThrow("modified protected Git metadata")
    expect(await git(workspacePath, "rev-parse", "HEAD")).toBe(
      initialized.commitHash
    )
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
title: ""
created: 2026-02-31
updated: 2026-07-19
type: 42
tags: [storage]
sources: [raw/articles/missing.md, invalid-source]
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
      expect.arrayContaining([
        "frontmatter.invalid-title",
        "frontmatter.invalid-date",
        "frontmatter.invalid-type",
        "frontmatter.invalid-source",
        "frontmatter.missing-source",
        "index.missing-page",
        "wikilink.broken",
      ])
    )
    expect(
      reportedCodes.filter((code) => code === "frontmatter.invalid-type")
    ).toHaveLength(1)
  })

  it("validates frontmatter arrays and recursive aliases", async () => {
    const parent = await mkdtemp(join(tmpdir(), "amend-wiki-engine-"))
    temporaryDirectories.push(parent)
    const workspacePath = join(parent, "wiki")
    const diagnosticsByTags = new Map<string, string[]>()
    let scalarSourceCodes: string[] = []
    const agent: WikiAgent = {
      name: "fake/tag-validator",
      async run(input) {
        const indexPath = join(input.workspacePath, "index.md")
        await writeFile(
          indexPath,
          "# Wiki Index\n\n## Concepts\n\n- [[write-ahead-logging]]\n"
        )
        const logPath = join(input.workspacePath, "log.md")
        await writeFile(
          logPath,
          `${await readFile(logPath, "utf8")}\n## [2026-07-19] ingest | Tag validation\n`
        )

        for (const tags of [
          "[]",
          "storage",
          "[Storage]",
          "[storage, storage]",
          "&tags [*tags]",
        ]) {
          await writeFile(
            join(input.workspacePath, "concepts/write-ahead-logging.md"),
            `---
title: Write-ahead logging
created: 2026-07-19
updated: 2026-07-19
type: concept
tags: ${tags}
sources: [raw/articles/write-ahead-logging.md]
---

# Write-ahead logging

The log supports recovery.
`
          )
          diagnosticsByTags.set(
            tags,
            (await input.lint())
              .map(({ code }) => code)
              .filter((code) => code.startsWith("frontmatter."))
          )
        }
        await writeFile(
          join(input.workspacePath, "concepts/write-ahead-logging.md"),
          `---
title: Write-ahead logging
created: 2026-07-19
updated: 2026-07-19
type: concept
tags: [storage]
sources: raw/articles/write-ahead-logging.md
---

# Write-ahead logging

The log supports recovery.
`
        )
        scalarSourceCodes = (await input.lint()).map(({ code }) => code)
        return { summary: "Invalid tags" }
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
    ).rejects.toThrow("Sources must be a non-empty YAML sequence")
    expect(diagnosticsByTags.get("[]")).toContain("frontmatter.invalid-tags")
    expect(diagnosticsByTags.get("storage")).toContain(
      "frontmatter.invalid-tags"
    )
    expect(diagnosticsByTags.get("[Storage]")).toContain(
      "frontmatter.invalid-tag"
    )
    expect(diagnosticsByTags.get("[storage, storage]")).toContain(
      "frontmatter.duplicate-tag"
    )
    expect(diagnosticsByTags.get("&tags [*tags]")).toContain(
      "frontmatter.invalid"
    )
    expect(scalarSourceCodes).toContain("frontmatter.invalid-source")
    expect(scalarSourceCodes).not.toContain("frontmatter.missing-source")
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
    ).rejects.toThrow("Wiki changed during ingest")
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
tags: [distributed-systems, storage]
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
