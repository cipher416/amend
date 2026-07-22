import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

import { createWikiEngine } from "../ingest/index.ts"
import {
  createWikiUpdateProposalSession,
  WikiUpdateConflictError,
  WikiUpdateValidationError,
} from "./index.ts"
import type { WikiUpdateAgentSession } from "./index.ts"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("wiki update proposal", () => {
  it("gives the agent exact managed paths and deletion guidance", async () => {
    const workspacePath = await createReadyWiki()
    let prompt = ""
    const session = await createWikiUpdateProposalSession({
      workspacePath,
      agent: fakeUpdateAgent(async (_worktreePath, agentPrompt) => {
        prompt = agentPrompt
      }),
    })

    await session.runTurn({ prompt: "Review the current organization." })

    expect(prompt).toContain("entities/, concepts/, comparisons/, or queries/")
    expect(prompt).toContain("concepts/write-ahead-logging.md")
    expect(prompt).toContain("delete tool")
    expect(prompt).toContain("Never create wiki pages at the wiki root")
    await session.discard()
  })

  it("keeps changes isolated until review and applies one validated commit", async () => {
    const workspacePath = await createReadyWiki()
    const agent = fakeUpdateAgent(async (worktreePath) => {
      const path = join(worktreePath, "concepts/write-ahead-logging.md")
      const current = await readFile(path, "utf8")
      await writeFile(
        path,
        current.replace(
          "The log supports recovery.",
          "The log records mutations before data pages change, preserving recovery order."
        )
      )
    })
    const session = await createWikiUpdateProposalSession({
      workspacePath,
      agent,
      createRunId: () => "019f89fa-0000-7000-8000-000000000001",
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    })

    const turn = await session.runTurn({
      prompt: "Clarify the recovery ordering guarantee.",
      contextPath: "concepts/write-ahead-logging.md",
    })

    expect(turn.summary).toBe("Clarify write-ahead log recovery ordering")
    expect(turn.changedFiles.map(({ path }) => path)).toEqual([
      "concepts/write-ahead-logging.md",
      "log.md",
    ])
    expect(await session.readDiff("concepts/write-ahead-logging.md")).toContain(
      "+The log records mutations before data pages change"
    )
    expect(
      await readFile(
        join(workspacePath, "concepts/write-ahead-logging.md"),
        "utf8"
      )
    ).toContain("The log supports recovery.")

    const result = await session.apply()

    expect(await git(workspacePath, "rev-parse", "HEAD")).toBe(
      result.commitHash
    )
    expect(
      await readFile(
        join(workspacePath, "concepts/write-ahead-logging.md"),
        "utf8"
      )
    ).toContain("preserving recovery order")
    expect(await readFile(join(workspacePath, "log.md"), "utf8")).toContain(
      "2026-07-22 | update | Clarify write-ahead log recovery ordering"
    )
    expect(
      JSON.parse(
        await readFile(
          join(workspacePath, `.amend/runs/${result.runId}.json`),
          "utf8"
        )
      )
    ).toMatchObject({
      kind: "update",
      baseCommit: session.baseCommit,
      agent: "fake/update-agent",
    })
    expect(await git(workspacePath, "status", "--porcelain")).toBe("")
  })

  it("rejects protected raw-source changes and restores the prior draft", async () => {
    const workspacePath = await createReadyWiki()
    const agent = fakeUpdateAgent(async (worktreePath) => {
      await writeFile(
        join(worktreePath, "raw/articles/write-ahead-logging.md"),
        "tampered\n"
      )
    })
    const session = await createWikiUpdateProposalSession({
      workspacePath,
      agent,
    })

    await expect(
      session.runTurn({ prompt: "Rewrite the source evidence." })
    ).rejects.toBeInstanceOf(WikiUpdateValidationError)
    expect(await git(workspacePath, "status", "--porcelain")).toBe("")
    await session.discard()
  })

  it("keeps a no-change answer reviewable without an applicable proposal", async () => {
    const workspacePath = await createReadyWiki()
    const session = await createWikiUpdateProposalSession({
      workspacePath,
      agent: fakeUpdateAgent(async () => undefined),
    })

    const turn = await session.runTurn({
      prompt: "Does this wiki already explain recovery?",
    })

    expect(turn.changedFiles).toEqual([])
    await expect(session.apply()).rejects.toThrow("no changes to apply")
    await session.discard()
  })

  it("reviews and applies a managed page deletion with its index repair", async () => {
    const workspacePath = await createReadyWiki()
    const session = await createWikiUpdateProposalSession({
      workspacePath,
      agent: fakeUpdateAgent(async (worktreePath) => {
        await rm(join(worktreePath, "concepts/write-ahead-logging.md"))
        await writeFile(
          join(worktreePath, "index.md"),
          "# Wiki Index\n\n## Concepts\n\n- [[checkpointing]]\n"
        )
      }),
    })

    const turn = await session.runTurn({
      prompt: "Delete the write-ahead logging page and repair the index.",
    })

    expect(turn.changedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "concepts/write-ahead-logging.md",
          status: "deleted",
        }),
        expect.objectContaining({ path: "index.md", status: "modified" }),
      ])
    )
    await session.apply()
    await expect(
      readFile(join(workspacePath, "concepts/write-ahead-logging.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(
      await readFile(join(workspacePath, "index.md"), "utf8")
    ).not.toContain("write-ahead-logging")
  })

  it("restores the previous valid proposal when a follow-up fails", async () => {
    const workspacePath = await createReadyWiki()
    let turn = 0
    const session = await createWikiUpdateProposalSession({
      workspacePath,
      agent: fakeUpdateAgent(async (worktreePath) => {
        turn += 1
        const path = join(worktreePath, "concepts/write-ahead-logging.md")
        if (turn === 1) {
          const content = await readFile(path, "utf8")
          await writeFile(
            path,
            content.replace("supports recovery", "supports ordered recovery")
          )
        } else {
          await writeFile(path, "# Missing frontmatter\n")
        }
      }),
    })

    await session.runTurn({ prompt: "Clarify recovery ordering." })
    const previousDiff = await session.readDiff(
      "concepts/write-ahead-logging.md"
    )
    await expect(
      session.runTurn({ prompt: "Remove all metadata." })
    ).rejects.toBeInstanceOf(WikiUpdateValidationError)

    expect(await session.readDiff("concepts/write-ahead-logging.md")).toBe(
      previousDiff
    )
    await session.discard()
  })

  it("rejects broken index links across the final wiki", async () => {
    const workspacePath = await createReadyWiki()
    const session = await createWikiUpdateProposalSession({
      workspacePath,
      agent: fakeUpdateAgent(async (worktreePath) => {
        await writeFile(
          join(worktreePath, "index.md"),
          "# Wiki Index\n\n## Concepts\n\n- [[missing-page]]\n"
        )
      }),
    })

    await expect(
      session.runTurn({ prompt: "Point the index at a missing page." })
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "wikilink.broken", path: "index.md" }),
      ]),
    })
    await session.discard()
  })

  it("preserves a proposal when the live wiki advances", async () => {
    const workspacePath = await createReadyWiki()
    const session = await createWikiUpdateProposalSession({
      workspacePath,
      agent: fakeUpdateAgent(async (worktreePath) => {
        const path = join(worktreePath, "concepts/write-ahead-logging.md")
        const content = await readFile(path, "utf8")
        await writeFile(
          path,
          content.replace("supports recovery", "supports ordered recovery")
        )
      }),
    })
    await session.runTurn({ prompt: "Clarify recovery ordering." })
    await writeFile(
      join(workspacePath, "log.md"),
      `${await readFile(join(workspacePath, "log.md"), "utf8")}\nExternal update\n`
    )
    await git(workspacePath, "add", "log.md")
    await git(workspacePath, "commit", "-m", "External update")

    await expect(session.apply()).rejects.toBeInstanceOf(
      WikiUpdateConflictError
    )
    expect(await session.readDiff("concepts/write-ahead-logging.md")).toContain(
      "supports ordered recovery"
    )
    await session.discard()
  })
})

async function createReadyWiki(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "amend-update-test-"))
  temporaryDirectories.push(parent)
  const workspacePath = join(parent, "wiki")
  const engine = createWikiEngine({
    agent: {
      name: "fake/unused",
      async run() {
        throw new Error("not used")
      },
    },
  })
  await engine.initialize({
    workspacePath,
    domain: "Database reliability",
  })
  await writeFile(
    join(workspacePath, "raw/articles/write-ahead-logging.md"),
    "# Write-ahead logging\n\nA WAL records mutations before pages change.\n"
  )
  await writeFile(
    join(workspacePath, "concepts/write-ahead-logging.md"),
    `---
title: Write-ahead logging
created: 2026-07-20
updated: 2026-07-20
type: concept
tags: [storage]
sources: [raw/articles/write-ahead-logging.md]
---

# Write-ahead logging

The log supports recovery.
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
sources: [raw/articles/write-ahead-logging.md]
---

# Checkpointing

A checkpoint bounds recovery work.
`
  )
  await writeFile(
    join(workspacePath, "index.md"),
    "# Wiki Index\n\n## Concepts\n\n- [[checkpointing]]\n- [[write-ahead-logging]]\n"
  )
  await git(workspacePath, "add", "--all")
  await git(workspacePath, "commit", "-m", "Seed wiki")
  return workspacePath
}

function fakeUpdateAgent(
  mutate: (worktreePath: string, prompt: string) => Promise<void>
): WikiUpdateAgentSession {
  return {
    name: "fake/update-agent",
    async prompt(input) {
      await mutate(input.workspacePath, input.prompt)
      return {
        output: "Clarified the recovery ordering guarantee.",
        summary: "Clarify write-ahead log recovery ordering",
      }
    },
    async abort() {},
    dispose() {},
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd })
  return stdout.trim()
}
