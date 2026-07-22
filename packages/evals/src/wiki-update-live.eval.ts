import { execFile } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import {
  createPiWikiUpdateAgentSession,
  readPiAgentSettings,
  runPiReadOnly,
} from "@workspace/wiki-engine/agent/pi"
import type { PiThinkingLevel } from "@workspace/wiki-engine/agent/pi"
import { createWikiEngine } from "@workspace/wiki-engine/ingest"
import { createWikiUpdateProposalSession } from "@workspace/wiki-engine/update"
import type {
  WikiUpdateAgentEvent,
  WikiUpdateProposalSession,
} from "@workspace/wiki-engine/update"

import { parseWikiJudgeResult } from "./wiki-evaluator.ts"
import { resolveWikiEvalModels } from "./wiki-models.ts"

const execFileAsync = promisify(execFile)
const temporaryParent = await mkdtemp(join(tmpdir(), "amend-update-live-eval-"))
const wikiPath = join(temporaryParent, "wiki")
let proposal: WikiUpdateProposalSession | undefined
let applied = false
let passed = false

try {
  console.error("[wiki-update-eval] Loading Pi configuration")
  const settings = await readPiAgentSettings()
  const { provider, model, judgeModel } = resolveWikiEvalModels(settings)
  const agentThinking = parseThinking(
    process.env.AMEND_PI_THINKING ??
      (provider === "openai-codex" ? "high" : settings.thinking)
  )
  const judgeThinking = parseThinking(
    process.env.AMEND_PI_JUDGE_THINKING ?? settings.thinking
  )
  const skillPath =
    process.env.AMEND_LLM_WIKI_SKILL ??
    join(import.meta.dirname, "../../wiki-engine/skills/llm-wiki/SKILL.md")

  await seedWiki(wikiPath)
  const baseCommit = await git(wikiPath, "rev-parse", "HEAD")
  const agent = createPiWikiUpdateAgentSession({
    provider,
    model,
    thinking: agentThinking,
    skillPath,
    timeoutMs: 15 * 60 * 1000,
  })
  proposal = await createWikiUpdateProposalSession({
    workspacePath: wikiPath,
    agent,
  })

  console.error(
    `[wiki-update-eval] Running first update turn with ${provider}/${model}`
  )
  const first = await proposal.runTurn({
    prompt:
      "Expand the write-ahead logging page with a concise section on group commit. Explain, using only the existing source, how batching changes throughput, latency, and the durability boundary. Update the index summary if useful. Privately remember the follow-up key `group-commit-eval`, but do not add it to any wiki file or mention it in your response during this turn.",
    contextPath: "concepts/write-ahead-logging.md",
    onEvent: logUpdateProgress,
  })
  const firstDiffs = await Promise.all(
    first.changedFiles.map(async ({ path }) => ({
      path,
      diff: await proposal?.readDiff(path),
    }))
  )

  console.error("[wiki-update-eval] Running contextual follow-up turn")
  const second = await proposal.runTurn({
    prompt:
      "Now add a focused comparison page for per-transaction fsync versus group commit. Link it with the write-ahead logging page in both directions, add it to the comparison section of the index, and add the private follow-up key from my prior message as one of the comparison page's tags.",
    onEvent: logUpdateProgress,
  })
  const diffs = await Promise.all(
    second.changedFiles.map(async ({ path }) => ({
      path,
      diff: await proposal?.readDiff(path),
    }))
  )

  console.error("[wiki-update-eval] Applying reviewed proposal")
  const result = await proposal.apply()
  applied = true
  const log = await readFile(join(wikiPath, "log.md"), "utf8")
  const run = JSON.parse(
    await readFile(join(wikiPath, `.amend/runs/${result.runId}.json`), "utf8")
  ) as {
    version?: unknown
    id?: unknown
    kind?: unknown
    createdAt?: unknown
    baseCommit?: unknown
    agent?: unknown
    summary?: unknown
    changedFiles?: unknown
  }
  const comparisonContents = await Promise.all(
    (await readdir(join(wikiPath, "comparisons"), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) =>
        readFile(join(wikiPath, "comparisons", entry.name), "utf8")
      )
  )
  const proposalPaths = second.changedFiles.map(({ path }) => path)
  const loggedPaths = proposalPaths.filter((path) => path !== "log.md")
  const manifestPath = `.amend/runs/${result.runId}.json`
  const mechanical = {
    firstTurnProducedChanges: first.changedFiles.some(
      ({ path }) => path !== "log.md"
    ),
    followUpProducedComparison: second.changedFiles.some(({ path }) =>
      path.startsWith("comparisons/")
    ),
    firstTurnKeptFollowUpKeyPrivate: firstDiffs
      .filter(({ path }) => path !== "log.md")
      .every(({ diff }) => !diff?.includes("group-commit-eval")),
    followUpUsedRetainedContext: comparisonContents.some((content) =>
      content.includes("group-commit-eval")
    ),
    onlyManagedPathsChanged: second.changedFiles.every(({ path }) =>
      /^(?:entities|concepts|comparisons|queries)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$|^(?:index|log)\.md$/.test(
        path
      )
    ),
    lazyDiffsAvailable: diffs.every(
      ({ diff }) => typeof diff === "string" && diff.includes("diff --git")
    ),
    appliedCommitFollowsBase:
      (await git(wikiPath, "rev-parse", `${result.commitHash}^`)) ===
      baseCommit,
    updateRunRecorded:
      run.version === 1 &&
      run.id === result.runId &&
      run.kind === "update" &&
      run.baseCommit === baseCommit &&
      run.agent === `${provider}/${model}` &&
      run.summary === second.summary &&
      typeof run.createdAt === "string" &&
      !Number.isNaN(Date.parse(run.createdAt)) &&
      JSON.stringify(run.changedFiles) === JSON.stringify(proposalPaths),
    generatedLogMatchesFinalProposal:
      log.includes(`| update | ${second.summary}`) &&
      loggedPaths.every((path) => log.includes(`- ${path}`)),
    applyResultListsManifestAndProposal:
      result.changedFiles.includes(manifestPath) &&
      proposalPaths.every((path) => result.changedFiles.includes(path)),
    exactlyOneUpdateLogEntry: [...log.matchAll(/\| update \|/g)].length === 1,
    liveWikiClean: (await git(wikiPath, "status", "--porcelain")) === "",
  }
  assertMechanicalEval(mechanical)

  console.error(
    `[wiki-update-eval] Judging the applied update with ${provider}/${judgeModel}`
  )
  const judgeResponse = await runPiReadOnly({
    provider,
    model: judgeModel,
    thinking: judgeThinking,
    workspacePath: wikiPath,
    timeoutMs: 10 * 60 * 1000,
    prompt: createJudgePrompt(),
  })
  const judge = parseWikiJudgeResult(judgeResponse.output)
  const minimumJudgeScore = Number(
    process.env.AMEND_UPDATE_EVAL_MIN_SCORE ?? 70
  )
  const report = {
    passed: judge.score >= minimumJudgeScore,
    models: {
      agent: `${provider}/${model}`,
      judge: `${provider}/${judgeModel}`,
      agentThinking,
      judgeThinking,
    },
    turns: [first, second],
    apply: result,
    mechanical,
    judge,
    judgeUsage: judgeResponse.usage,
    wikiPath,
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) {
    throw new Error(
      `Wiki update quality score ${judge.score} is below ${minimumJudgeScore}`
    )
  }
  passed = true
} finally {
  if (proposal && !applied) await proposal.discard().catch(() => undefined)
  const keep = process.env.AMEND_EVAL_KEEP === "1" || !passed
  if (keep) {
    console.error(`Wiki update eval workspace retained at ${wikiPath}`)
  } else {
    await rm(temporaryParent, { recursive: true, force: true })
  }
}

async function seedWiki(rootPath: string): Promise<void> {
  const engine = createWikiEngine({
    agent: {
      name: "eval/unused",
      async run() {
        throw new Error("The seeded update eval does not ingest with an agent")
      },
    },
  })
  await engine.initialize({
    workspacePath: rootPath,
    domain: "Database durability and recovery engineering",
  })
  await writeFile(
    join(rootPath, "raw/articles/transaction-durability.md"),
    `# Transaction durability notes

A write-ahead log records a transaction's changes before the corresponding data pages are written. A transaction is durable only after the log records required for its commit reach stable storage.

With per-transaction fsync, each committing transaction waits for its own flush. This gives a simple durability boundary but can limit throughput when storage synchronization is expensive.

Group commit batches multiple transactions behind one flush. It amortizes synchronization cost and usually increases throughput, while a transaction may wait for the batch and therefore see additional latency. Transactions in the batch cross the durability boundary together when the shared flush completes; none should be acknowledged as durable before that point.
`
  )
  await writeFile(
    join(rootPath, "concepts/write-ahead-logging.md"),
    `---
title: Write-ahead logging
created: 2026-07-22
updated: 2026-07-22
type: concept
tags: [database-recovery, durability]
sources: [raw/articles/transaction-durability.md]
---

# Write-ahead logging

A write-ahead log records transaction changes before their data pages are written. A commit becomes durable after its required log records reach stable storage.
`
  )
  await writeFile(
    join(rootPath, "index.md"),
    "# Wiki Index\n\n## Entities\n\n## Concepts\n\n- [[write-ahead-logging]] - Records changes before data pages and defines the commit durability boundary.\n\n## Comparisons\n\n## Queries\n"
  )
  await git(rootPath, "add", "--all")
  await git(rootPath, "commit", "-m", "Seed update eval wiki")
}

function assertMechanicalEval(mechanical: Record<string, boolean>): void {
  const failed = Object.entries(mechanical)
    .filter(([, value]) => !value)
    .map(([name]) => name)
  if (failed.length > 0) {
    throw new Error(`Mechanical wiki update eval failed: ${failed.join(", ")}`)
  }
}

function createJudgePrompt(): string {
  return `Evaluate whether the applied wiki update correctly fulfills this two-turn request:
1. Explain group commit on the write-ahead logging page, including throughput, latency, and the durability boundary.
2. Add a comparison of per-transaction fsync and group commit, link it bidirectionally with the concept page, and index it.

Read SCHEMA.md, index.md, log.md, raw/articles/transaction-durability.md, and all managed wiki pages. Penalize unsupported claims, missing bidirectional links, invalid organization, repetition, or vague trade-off analysis.

Score these criteria from 0 to 100:
- sourceFidelity: claims match and cite the supplied durability notes.
- crossSourceSynthesis: use this for request fulfillment and quality of the fsync/group-commit comparison.
- organization: page boundaries, frontmatter, and concision form a durable wiki.
- navigability: index entries and bidirectional wikilinks make the comparison discoverable.

Return JSON only in this exact shape:
{
  "score": 0,
  "criteria": {
    "sourceFidelity": 0,
    "crossSourceSynthesis": 0,
    "organization": 0,
    "navigability": 0
  },
  "strengths": ["..."],
  "issues": ["..."]
}`
}

function parseThinking(value: string): PiThinkingLevel {
  if (
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
  ) {
    return value as PiThinkingLevel
  }
  throw new Error(`Unsupported Pi thinking level: ${value}`)
}

function logUpdateProgress(event: WikiUpdateAgentEvent): void {
  if (event.type === "tool-start") {
    console.error(`[wiki-update-eval] Pi tool: ${event.toolName}`)
  } else if (event.type === "tool-end" && event.isError) {
    console.error(`[wiki-update-eval] Pi tool failed: ${event.toolName}`)
  } else if (event.type === "repair") {
    console.error("[wiki-update-eval] Pi is repairing validation errors")
  } else if (event.type === "validation") {
    console.error(`[wiki-update-eval] Validation ${event.status}`)
  }
}

async function git(rootPath: string, ...arguments_: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", rootPath, ...arguments_], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  return result.stdout.trim()
}
