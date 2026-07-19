import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { promisify } from "node:util"

import {
  createPiWikiAgent,
  readPiAgentSettings,
  runPiReadOnly,
} from "@workspace/wiki-engine/pi-agent"
import type { PiThinkingLevel } from "@workspace/wiki-engine/pi-agent"
import { createWikiEngine } from "@workspace/wiki-engine/wiki-engine"
import TurndownService from "turndown"

import { parseWikiJudgeResult } from "./wiki-evaluator.ts"
import { resolveWikiEvalModels } from "./wiki-models.ts"

const execFileAsync = promisify(execFile)
const papers = [
  {
    arxivId: "1706.03762",
    title: "Attention Is All You Need",
    path: "raw/papers/attention-is-all-you-need.md",
    pdfUrl: "https://arxiv.org/pdf/1706.03762",
  },
  {
    arxivId: "1803.02155",
    title: "Self-Attention with Relative Position Representations",
    path: "raw/papers/self-attention-relative-position-representations.md",
    pdfUrl: "https://arxiv.org/pdf/1803.02155",
  },
] as const

const temporaryParent = await mkdtemp(join(tmpdir(), "amend-wiki-live-eval-"))
const workspacePath = join(temporaryParent, "wiki")
let passed = false

try {
  console.error("[wiki-eval] Loading Pi configuration and paper sources")
  const settings = await readPiAgentSettings()
  const { provider, model, judgeModel } = resolveWikiEvalModels(settings)
  const agentThinking = parseThinking(
    process.env.AMEND_PI_THINKING ??
      (provider === "openai-codex" ? "medium" : settings.thinking)
  )
  const judgeThinking = parseThinking(
    process.env.AMEND_PI_JUDGE_THINKING ?? settings.thinking
  )
  const skillPath =
    process.env.AMEND_LLM_WIKI_SKILL ??
    join(homedir(), ".agents/skills/research/llm-wiki/SKILL.md")
  const sourceDocuments = await Promise.all(papers.map(loadPaperMarkdown))
  const agent = createPiWikiAgent({
    provider,
    model,
    thinking: agentThinking,
    skillPath,
    timeoutMs: 15 * 60 * 1000,
    onProgress: logPiProgress,
  })
  const engine = createWikiEngine({ agent })
  const initialized = await engine.initialize({
    workspacePath,
    domain:
      "Neural network architecture research, with emphasis on attention mechanisms",
  })
  console.error(`[wiki-eval] Ingesting ${papers[0].title} with ${model}`)
  const first = await engine.ingest({
    workspacePath,
    sources: [sourceDocuments[0]],
    instruction:
      "Capture the central Transformer architecture, self-attention, multi-head attention, and positional encoding concepts. Prefer a small set of substantial pages over one page per section.",
  })
  const firstRaw = await readFile(join(workspacePath, papers[0].path), "utf8")
  console.error(`[wiki-eval] Ingesting ${papers[1].title} with ${model}`)
  const second = await engine.ingest({
    workspacePath,
    sources: [sourceDocuments[1]],
    instruction:
      "Integrate this paper into the existing Transformer wiki. Explain how relative position representations extend the earlier architecture, update existing pages where appropriate, and create explicit wikilinks between related concepts.",
  })
  const currentFirstRaw = await readFile(
    join(workspacePath, papers[0].path),
    "utf8"
  )
  const pages = await readPages(workspacePath)
  const index = await readFile(join(workspacePath, "index.md"), "utf8")
  const log = await readFile(join(workspacePath, "log.md"), "utf8")
  const history = await git(workspacePath, "log", "--format=%H%x09%B%x00")
  const mechanical = {
    firstCommitFollowsInitialization:
      first.baseCommit === initialized.commitHash,
    secondCommitFollowsFirst: second.baseCommit === first.commitHash,
    firstRawSourcePreserved: currentFirstRaw === firstRaw,
    firstSourceReferenced: pages.some(({ content }) =>
      content.includes(papers[0].path)
    ),
    secondSourceReferenced: pages.some(({ content }) =>
      content.includes(papers[1].path)
    ),
    pageCount: pages.length,
    indexedPageCount: pages.filter(({ path }) =>
      index.includes(`[[${basename(path, ".md")}]]`)
    ).length,
    ingestLogEntries: [...log.matchAll(/\bingest\b/gi)].length,
    runTrailers: [...history.matchAll(/Amend-Run:/g)].length,
  }
  assertMechanicalEval(mechanical)

  console.error(`[wiki-eval] Judging the resulting wiki with ${judgeModel}`)
  const judgeResponse = await runPiReadOnly({
    provider,
    model: judgeModel,
    thinking: judgeThinking,
    workspacePath,
    timeoutMs: 10 * 60 * 1000,
    onProgress: logPiProgress,
    prompt: createJudgePrompt(),
  })
  const judge = parseWikiJudgeResult(judgeResponse.output)
  const minimumJudgeScore = Number(process.env.AMEND_EVAL_MIN_SCORE ?? 70)
  const report = {
    passed: judge.score >= minimumJudgeScore,
    models: {
      agent: `${provider}/${model}`,
      judge: `${provider}/${judgeModel}`,
      agentThinking,
      judgeThinking,
    },
    papers: sourceDocuments.map(({ path, content, sourceUrl }) => ({
      path,
      sourceUrl,
      extractedSha256: createHash("sha256")
        .update(content, "utf8")
        .digest("hex"),
      characters: content.length,
    })),
    runs: [first, second],
    mechanical,
    judge,
    judgeUsage: judgeResponse.usage,
    workspacePath,
  }
  console.log(JSON.stringify(report, null, 2))

  if (!report.passed) {
    throw new Error(
      `Wiki quality score ${judge.score} is below ${minimumJudgeScore}`
    )
  }
  passed = true
} finally {
  const keep = process.env.AMEND_EVAL_KEEP === "1" || !passed
  if (keep) {
    console.error(`Wiki eval workspace retained at ${workspacePath}`)
  } else {
    await rm(temporaryParent, { recursive: true, force: true })
  }
}

async function loadPaperMarkdown(paper: (typeof papers)[number]) {
  const htmlUrl = `https://ar5iv.labs.arxiv.org/html/${paper.arxivId}`
  const response = await fetch(htmlUrl, {
    headers: { "User-Agent": "Amend wiki eval/0.0.1" },
  })
  if (!response.ok) {
    throw new Error(`Could not fetch ${htmlUrl}: HTTP ${response.status}`)
  }
  const html = await response.text()
  const article = html.match(/<article\b[\s\S]*<\/article>/i)?.[0] ?? html
  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  })
  turndown.remove(["script", "style", "nav", "footer"])
  const markdown = boundPaperMarkdown(
    turndown.turndown(article).replace(/\n{3,}/g, "\n\n")
  )

  return {
    path: paper.path,
    sourceUrl: paper.pdfUrl,
    content: `# ${paper.title}\n\nOriginal PDF: ${paper.pdfUrl}\n\n${markdown}\n`,
  }
}

function boundPaperMarkdown(markdown: string): string {
  const maximumCharacters = 32_000
  if (markdown.length <= maximumCharacters) return markdown
  const conclusionStart = markdown.search(
    /\n#{1,3}\s+(?:Conclusion|Conclusions)\b/i
  )
  const conclusion =
    conclusionStart === -1
      ? ""
      : markdown.slice(conclusionStart, conclusionStart + 8_000)
  return `${markdown.slice(0, maximumCharacters - conclusion.length)}\n\n${conclusion}`
}

async function readPages(
  rootPath: string
): Promise<Array<{ path: string; content: string }>> {
  const pages: Array<{ path: string; content: string }> = []
  for (const directory of ["entities", "concepts", "comparisons", "queries"]) {
    const directoryPath = join(rootPath, directory)
    const entries = await readdir(directoryPath, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") return []
        throw error
      }
    )
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      pages.push({
        path: `${directory}/${entry.name}`,
        content: await readFile(join(directoryPath, entry.name), "utf8"),
      })
    }
  }
  return pages
}

function assertMechanicalEval(mechanical: {
  firstCommitFollowsInitialization: boolean
  secondCommitFollowsFirst: boolean
  firstRawSourcePreserved: boolean
  firstSourceReferenced: boolean
  secondSourceReferenced: boolean
  pageCount: number
  indexedPageCount: number
  ingestLogEntries: number
  runTrailers: number
}): void {
  const failed = [
    [
      "first commit follows initialization",
      mechanical.firstCommitFollowsInitialization,
    ],
    ["second commit follows first", mechanical.secondCommitFollowsFirst],
    ["first raw source remains immutable", mechanical.firstRawSourcePreserved],
    ["first source is cited", mechanical.firstSourceReferenced],
    ["second source is cited", mechanical.secondSourceReferenced],
    ["wiki has at least two pages", mechanical.pageCount >= 2],
    [
      "every page is indexed",
      mechanical.indexedPageCount === mechanical.pageCount,
    ],
    ["both runs are logged", mechanical.ingestLogEntries >= 2],
    ["both commits have run trailers", mechanical.runTrailers >= 2],
  ].filter(([, value]) => !value)
  if (failed.length > 0) {
    throw new Error(
      `Mechanical wiki eval failed: ${failed.map(([name]) => name).join(", ")}`
    )
  }
}

function createJudgePrompt(): string {
  return `Evaluate the wiki produced from these two papers:
- Attention Is All You Need (arXiv:1706.03762)
- Self-Attention with Relative Position Representations (arXiv:1803.02155)

Read SCHEMA.md, index.md, log.md, both raw/papers files, and all pages under entities/, concepts/, comparisons/, and queries/.

Score these criteria from 0 to 100:
- sourceFidelity: factual claims match and cite the raw papers.
- crossSourceSynthesis: the wiki clearly explains how relative position representations extend the original Transformer.
- organization: page boundaries, frontmatter, and level of detail form a useful durable wiki.
- navigability: index entries and wikilinks make related knowledge discoverable.

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

function logPiProgress(
  event: Parameters<
    NonNullable<Parameters<typeof createPiWikiAgent>[0]["onProgress"]>
  >[0]
): void {
  if (event.type === "tool-start") {
    console.error(`[wiki-eval] Pi tool: ${event.toolName}`)
  } else if (event.type === "tool-end" && event.isError) {
    console.error(`[wiki-eval] Pi tool failed: ${event.toolName}`)
  } else if (event.type === "turn-end") {
    console.error("[wiki-eval] Pi turn complete")
  } else if (event.type === "retry") {
    console.error("[wiki-eval] Pi is retrying the model request")
  }
}

async function git(rootPath: string, ...arguments_: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", rootPath, ...arguments_], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  return result.stdout.trim()
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
