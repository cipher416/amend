import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, posix, resolve } from "node:path"
import { parse as parseYaml } from "yaml"

export interface WikiAgentRunInput {
  workspacePath: string
  runId: string
  sourcePaths: readonly string[]
  prompt: string
  lint: () => Promise<readonly WikiLintDiagnostic[]>
}

export interface WikiLintDiagnostic {
  code: string
  message: string
  path?: string
}

export class WikiLintError extends Error {
  readonly diagnostics: readonly WikiLintDiagnostic[]

  constructor(diagnostics: readonly WikiLintDiagnostic[]) {
    super(
      `Wiki lint failed:\n${diagnostics
        .map(
          ({ code, message, path }) =>
            `- [${code}]${path ? ` ${path}:` : ""} ${message}`
        )
        .join("\n")}`
    )
    this.name = "WikiLintError"
    this.diagnostics = diagnostics
  }
}

export interface WikiAgentRunResult {
  summary: string
  output?: string
  usage?: {
    inputTokens: number
    outputTokens: number
    cost: number
  }
}

export interface WikiAgent {
  name: string
  run: (input: WikiAgentRunInput) => Promise<WikiAgentRunResult>
}

export interface WikiSourceInput {
  path: string
  content: string
  sourceUrl?: string
}

export interface WikiRunResult {
  runId: string
  baseCommit: string
  commitHash: string
  changedFiles: readonly string[]
  summary: string
  agent: string
  usage?: WikiAgentRunResult["usage"]
}

export interface InitializedWiki {
  workspacePath: string
  commitHash: string
}

export interface WikiEngine {
  initialize: (input: {
    workspacePath: string
    domain: string
  }) => Promise<InitializedWiki>
  ingest: (input: {
    workspacePath: string
    sources: readonly WikiSourceInput[]
    instruction?: string
  }) => Promise<WikiRunResult>
}

interface WikiEngineOptions {
  agent: WikiAgent
  createRunId?: () => string
  now?: () => Date
}

interface PreparedSource {
  path: string
  content: string
  hash: string
  storedContent: string
  sourceUrl?: string
}

const pageDirectories = ["entities", "concepts", "comparisons", "queries"]
const managedRootFiles = new Set(["SCHEMA.md", "index.md", "log.md"])

export function createWikiEngine(options: WikiEngineOptions): WikiEngine {
  const createRunId = options.createRunId ?? randomUUID
  const now = options.now ?? (() => new Date())

  return {
    async initialize(input) {
      const workspacePath = resolve(input.workspacePath)
      const domain = input.domain.trim()
      if (!domain) throw new Error("Wiki domain is required")

      await mkdir(workspacePath)
      await Promise.all(
        [
          ".amend/runs",
          "raw/articles",
          "raw/papers",
          "raw/transcripts",
          "raw/assets",
          ...pageDirectories,
        ].map((path) => mkdir(join(workspacePath, path), { recursive: true }))
      )
      await Promise.all([
        writeFile(
          join(workspacePath, ".amend/workspace.json"),
          `${JSON.stringify({ version: 1, domain }, null, 2)}\n`
        ),
        writeFile(join(workspacePath, "SCHEMA.md"), createSchema(domain)),
        writeFile(join(workspacePath, "index.md"), createIndex()),
        writeFile(join(workspacePath, "log.md"), createLog(domain)),
        writeFile(join(workspacePath, ".gitignore"), ".amend/run.lock\n"),
      ])
      await git(workspacePath, "init", "--initial-branch=main")
      await git(workspacePath, "config", "user.name", "Amend")
      await git(workspacePath, "config", "user.email", "amend@example.invalid")
      await git(workspacePath, "config", "commit.gpgsign", "false")
      await git(workspacePath, "add", "--all")
      await git(workspacePath, "commit", "-m", "Initialize wiki")

      return {
        workspacePath: await realpath(workspacePath),
        commitHash: await git(workspacePath, "rev-parse", "HEAD"),
      }
    },

    async ingest(input) {
      const workspacePath = await validateWorkspace(input.workspacePath)
      const lockPath = join(workspacePath, ".git/amend-run.lock")
      const lock = await acquireLock(lockPath)

      try {
        const status = await git(workspacePath, "status", "--porcelain")
        if (status) throw new Error("Wiki workspace must be clean")

        const runId = validateRunId(createRunId())
        const createdAt = now().toISOString()
        const baseCommit = await git(workspacePath, "rev-parse", "HEAD")
        const sources = prepareSources(input.sources, createdAt)
        const temporaryParent = await createTemporaryParent()
        const worktreePath = join(temporaryParent, "worktree")

        try {
          await git(
            workspacePath,
            "worktree",
            "add",
            "--detach",
            worktreePath,
            baseCommit
          )
          await Promise.all(
            [
              ".amend/runs",
              "raw/articles",
              "raw/papers",
              "raw/transcripts",
              "raw/assets",
              ...pageDirectories,
            ].map((path) =>
              mkdir(join(worktreePath, path), { recursive: true })
            )
          )
          const existingRaw = await readFilesUnder(join(worktreePath, "raw"))
          const originalLog = await readFile(
            join(worktreePath, "log.md"),
            "utf8"
          )

          for (const source of sources) {
            if (existingRaw.has(source.path.slice("raw/".length))) {
              throw new Error(`Raw source already exists: ${source.path}`)
            }

            const destination = join(worktreePath, ...source.path.split("/"))
            await mkdir(dirname(destination), { recursive: true })
            await writeFile(destination, source.storedContent)
          }
          const lint = () =>
            lintAgentChanges({
              worktreePath,
              existingRaw,
              sources,
              originalLog,
            })

          const agentResult = await options.agent.run({
            workspacePath: worktreePath,
            runId,
            sourcePaths: sources.map(({ path }) => path),
            prompt: createIngestPrompt({
              runId,
              sourcePaths: sources.map(({ path }) => path),
              instruction: input.instruction,
            }),
            lint,
          })
          const summary = agentResult.summary.trim()
          if (!summary) throw new Error("Wiki agent summary is required")
          const currentHead = await git(worktreePath, "rev-parse", "HEAD")
          if (currentHead !== baseCommit) {
            throw new Error("Wiki agent must not create Git commits")
          }

          const diagnostics = await lint()
          if (diagnostics.length > 0) throw new WikiLintError(diagnostics)
          const manifestPath = `.amend/runs/${runId}.json`
          await writeFile(
            join(worktreePath, manifestPath),
            `${JSON.stringify(
              {
                version: 1,
                id: runId,
                kind: "ingest",
                createdAt,
                baseCommit,
                agent: options.agent.name,
                sources: sources.map(({ path, hash, sourceUrl }) => ({
                  path,
                  hash,
                  ...(sourceUrl ? { sourceUrl } : {}),
                })),
                summary,
              },
              null,
              2
            )}\n`
          )
          await validateManagedPaths(worktreePath, runId)
          await git(worktreePath, "add", "--all")
          await git(
            worktreePath,
            "commit",
            "-m",
            `${commitSubject(summary)}\n\nAmend-Run: ${runId}\nAgent: ${options.agent.name}`
          )
          const commitHash = await git(worktreePath, "rev-parse", "HEAD")
          const changedFiles = (
            await git(
              worktreePath,
              "diff-tree",
              "--no-commit-id",
              "--name-only",
              "-r",
              commitHash
            )
          )
            .split("\n")
            .filter(Boolean)

          if (await git(workspacePath, "status", "--porcelain")) {
            throw new Error("Wiki workspace changed during ingest")
          }
          await git(
            workspacePath,
            "update-ref",
            "refs/heads/main",
            commitHash,
            baseCommit
          )
          try {
            await git(
              workspacePath,
              "read-tree",
              "-u",
              "-m",
              baseCommit,
              commitHash
            )
          } catch (error) {
            try {
              await git(
                workspacePath,
                "update-ref",
                "refs/heads/main",
                baseCommit,
                commitHash
              )
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                "Wiki promotion failed and the main branch could not be rolled back"
              )
            }
            throw new Error("Wiki workspace changed during promotion", {
              cause: error,
            })
          }

          return {
            runId,
            baseCommit,
            commitHash,
            changedFiles,
            summary,
            agent: options.agent.name,
            ...(agentResult.usage ? { usage: agentResult.usage } : {}),
          }
        } finally {
          await git(
            workspacePath,
            "worktree",
            "remove",
            "--force",
            worktreePath
          ).catch(() => undefined)
          await rm(temporaryParent, { recursive: true, force: true })
        }
      } finally {
        await releaseLock(lockPath, lock)
      }
    },
  }
}

async function validateWorkspace(workspacePathInput: string): Promise<string> {
  const workspacePath = await realpath(resolve(workspacePathInput))
  const record = JSON.parse(
    await readFile(join(workspacePath, ".amend/workspace.json"), "utf8")
  ) as { version?: unknown }
  if (record.version !== 1) throw new Error("Unsupported wiki workspace")
  if (
    (await git(workspacePath, "symbolic-ref", "HEAD")) !== "refs/heads/main"
  ) {
    throw new Error("Wiki workspace must use the main branch")
  }
  return workspacePath
}

function prepareSources(
  sourceInputs: readonly WikiSourceInput[],
  createdAt: string
): PreparedSource[] {
  if (sourceInputs.length === 0)
    throw new Error("At least one source is required")
  const seen = new Set<string>()

  return sourceInputs.map((source) => {
    const path = validateSourcePath(source.path)
    if (seen.has(path)) throw new Error(`Duplicate source path: ${path}`)
    seen.add(path)
    const content = source.content
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n")
    if (!content.trim()) throw new Error(`Source is empty: ${path}`)
    if (Buffer.byteLength(content, "utf8") > 5_000_000) {
      throw new Error(`Source is too large: ${path}`)
    }
    const hash = createHash("sha256").update(content, "utf8").digest("hex")
    const sourceUrl = source.sourceUrl
      ? validateSourceUrl(source.sourceUrl)
      : undefined

    return {
      path,
      content,
      hash,
      ...(sourceUrl ? { sourceUrl } : {}),
      storedContent: `---\n${sourceUrl ? `source_url: ${sourceUrl}\n` : ""}ingested: ${createdAt.slice(0, 10)}\nsha256: ${hash}\n---\n\n${content}`,
    }
  })
}

function validateSourceUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "https:") throw new Error("Source URL must use HTTPS")
  return url.href
}

function validateSourcePath(pathInput: string): string {
  if (pathInput.includes("\\") || pathInput.includes("\0")) {
    throw new Error("Source path contains forbidden characters")
  }
  const path = posix.normalize(pathInput)
  if (path !== pathInput || !isValidSourcePath(path)) {
    throw new Error(`Invalid source path: ${pathInput}`)
  }
  return path
}

function isValidSourcePath(path: string): boolean {
  return /^raw\/(?:articles|papers|transcripts)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(
    path
  )
}

async function lintAgentChanges(input: {
  worktreePath: string
  existingRaw: ReadonlyMap<string, string>
  sources: readonly PreparedSource[]
  originalLog: string
}): Promise<WikiLintDiagnostic[]> {
  const diagnostics: WikiLintDiagnostic[] = []
  const report = (diagnostic: WikiLintDiagnostic) => {
    diagnostics.push(diagnostic)
  }
  const currentRaw = await readFilesUnder(join(input.worktreePath, "raw"))
  for (const [path, content] of input.existingRaw) {
    if (currentRaw.get(path) !== content) {
      report({
        code: "raw.modified",
        path: `raw/${path}`,
        message: "Wiki agent modified immutable raw source",
      })
    }
  }
  const expectedNewPaths = new Set(
    input.sources.map(({ path }) => path.slice("raw/".length))
  )
  for (const [path, content] of currentRaw) {
    if (input.existingRaw.has(path)) continue
    const source = input.sources.find(
      ({ path: sourcePath }) => sourcePath.slice("raw/".length) === path
    )
    if (!source || content !== source.storedContent) {
      report({
        code: "raw.unmanaged",
        path: `raw/${path}`,
        message: "The agent added or modified an unmanaged raw source",
      })
      continue
    }
    expectedNewPaths.delete(path)
  }
  for (const path of expectedNewPaths) {
    report({
      code: "raw.missing",
      path: `raw/${path}`,
      message: "The agent removed an imported raw source",
    })
  }

  const log = await readFile(join(input.worktreePath, "log.md"), "utf8").catch(
    () => undefined
  )
  if (log === undefined) {
    report({
      code: "log.missing",
      path: "log.md",
      message: "The wiki log is missing",
    })
  } else {
    if (!log.startsWith(input.originalLog) || log === input.originalLog) {
      report({
        code: "log.not-appended",
        path: "log.md",
        message: "The wiki log must be append-only for every ingest run",
      })
    }
    if (!/\bingest\b/i.test(log.slice(input.originalLog.length))) {
      report({
        code: "log.missing-ingest",
        path: "log.md",
        message: "The new log entry must identify the ingest action",
      })
    }
  }

  const pages = await readWikiPages(input.worktreePath)
  if (pages.length === 0) {
    report({
      code: "page.missing",
      message: "The agent must create a wiki page",
    })
  }
  const index = await readFile(
    join(input.worktreePath, "index.md"),
    "utf8"
  ).catch(() => undefined)
  if (index === undefined) {
    report({
      code: "index.missing",
      path: "index.md",
      message: "The wiki index is missing",
    })
  }
  const pathsByPageName = new Map<string, string[]>()
  for (const page of pages) {
    const pageName = basename(page.path, ".md")
    const paths = pathsByPageName.get(pageName) ?? []
    paths.push(page.path)
    pathsByPageName.set(pageName, paths)
  }
  for (const [pageName, paths] of pathsByPageName) {
    if (paths.length > 1) {
      report({
        code: "page.duplicate-slug",
        message: `Page slug ${pageName} is duplicated by ${paths.join(", ")}`,
      })
    }
  }
  const pageNames = new Set(pathsByPageName.keys())

  for (const page of pages) {
    diagnostics.push(
      ...(await lintPageFrontmatter(
        page.path,
        page.content,
        input.worktreePath
      ))
    )
    const pageName = basename(page.path, ".md")
    if (index !== undefined && !index.includes(`[[${pageName}]]`)) {
      report({
        code: "index.missing-page",
        path: "index.md",
        message: `The index is missing wiki page ${pageName}`,
      })
    }
    for (const link of page.content.matchAll(
      /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g
    )) {
      const target = link[1].trim()
      if (target && !pageNames.has(target)) {
        report({
          code: "wikilink.broken",
          path: page.path,
          message: `Wikilink target does not exist: ${target}`,
        })
      }
    }
  }

  const changedPaths = await changedPathsInWorktree(input.worktreePath)
  if (
    !changedPaths.some((path) =>
      pageDirectories.some((dir) => path.startsWith(`${dir}/`))
    )
  ) {
    report({
      code: "page.unchanged",
      message: "The agent must create or update at least one wiki page",
    })
  }
  for (const path of changedPaths) {
    const allowed =
      managedRootFiles.has(path) ||
      /^raw\/(?:articles|papers|transcripts)\/.+\.md$/.test(path) ||
      pageDirectories.some((directory) =>
        new RegExp(`^${directory}/[a-z0-9]+(?:-[a-z0-9]+)*\\.md$`).test(path)
      )
    if (!allowed) {
      report({
        code: "path.unmanaged",
        path,
        message: "The agent changed an unmanaged path",
      })
    }
  }

  return diagnostics
}

async function lintPageFrontmatter(
  pagePath: string,
  content: string,
  worktreePath: string
): Promise<WikiLintDiagnostic[]> {
  const diagnostics: WikiLintDiagnostic[] = []
  let frontmatter: Map<string, unknown>
  try {
    frontmatter = parseFrontmatter(content, pagePath)
  } catch (error) {
    diagnostics.push({
      code: "frontmatter.invalid",
      path: pagePath,
      message: error instanceof Error ? error.message : "Invalid frontmatter",
    })
    return diagnostics
  }
  for (const field of [
    "title",
    "created",
    "updated",
    "type",
    "tags",
    "sources",
  ]) {
    if (!frontmatter.has(field)) {
      diagnostics.push({
        code: "frontmatter.missing-field",
        path: pagePath,
        message: `Missing required frontmatter field: ${field}`,
      })
    }
  }
  const typeValue = frontmatter.get("type")
  const type = typeof typeValue === "string" ? typeValue : undefined
  const typeDirectories = new Map([
    ["entity", "entities"],
    ["concept", "concepts"],
    ["comparison", "comparisons"],
    ["query", "queries"],
  ])
  if (!type || !typeDirectories.has(type)) {
    diagnostics.push({
      code: "frontmatter.invalid-type",
      path: pagePath,
      message: `Invalid wiki page type: ${type ?? "missing"}`,
    })
  } else if (!pagePath.startsWith(`${typeDirectories.get(type)}/`)) {
    diagnostics.push({
      code: "frontmatter.type-directory-mismatch",
      path: pagePath,
      message: `Page type ${type} does not match its directory`,
    })
  }
  const sourcePaths = parseStringList(frontmatter.get("sources"))
  if (sourcePaths.length === 0) {
    diagnostics.push({
      code: "frontmatter.missing-source",
      path: pagePath,
      message: "The page must cite at least one raw source",
    })
  }
  for (const sourcePath of sourcePaths) {
    if (!isValidSourcePath(sourcePath)) {
      diagnostics.push({
        code: "frontmatter.invalid-source",
        path: pagePath,
        message: `Invalid raw source path: ${sourcePath}`,
      })
      continue
    }
    const exists = await readFile(
      join(worktreePath, ...sourcePath.split("/")),
      "utf8"
    )
      .then(() => true)
      .catch(() => false)
    if (!exists) {
      diagnostics.push({
        code: "frontmatter.missing-source",
        path: pagePath,
        message: `Cited raw source does not exist: ${sourcePath}`,
      })
    }
  }
  return diagnostics
}

function parseFrontmatter(content: string, path: string): Map<string, unknown> {
  if (!content.startsWith("---\n")) {
    throw new Error(`Wiki page is missing YAML frontmatter: ${path}`)
  }
  const end = content.indexOf("\n---\n", 4)
  if (end === -1)
    throw new Error(`Wiki page frontmatter is not closed: ${path}`)
  const value = parseYaml(content.slice(4, end)) as unknown
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Wiki page frontmatter must be a YAML object: ${path}`)
  }
  return new Map(Object.entries(value))
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

async function validateManagedPaths(
  worktreePath: string,
  runId: string
): Promise<void> {
  const paths = await changedPathsInWorktree(worktreePath)
  const runManifest = `.amend/runs/${runId}.json`

  for (const path of paths) {
    const allowed =
      managedRootFiles.has(path) ||
      path === runManifest ||
      /^raw\/(?:articles|papers|transcripts)\/.+\.md$/.test(path) ||
      pageDirectories.some((directory) =>
        new RegExp(`^${directory}/[a-z0-9]+(?:-[a-z0-9]+)*\\.md$`).test(path)
      )
    if (!allowed)
      throw new Error(`Wiki agent changed an unmanaged path: ${path}`)
  }
}

async function changedPathsInWorktree(worktreePath: string): Promise<string[]> {
  const tracked = await git(worktreePath, "diff", "--name-only", "HEAD")
  const untracked = await git(
    worktreePath,
    "ls-files",
    "--others",
    "--exclude-standard"
  )
  return [...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean)
}

async function readWikiPages(
  worktreePath: string
): Promise<Array<{ path: string; content: string }>> {
  const pages: Array<{ path: string; content: string }> = []
  for (const directory of pageDirectories) {
    const files = await readFilesUnder(join(worktreePath, directory))
    for (const [path, content] of files) {
      if (path.endsWith(".md"))
        pages.push({ path: `${directory}/${path}`, content })
    }
  }
  return pages
}

async function readFilesUnder(rootPath: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()

  async function visit(
    currentPath: string,
    relativePath: string
  ): Promise<void> {
    for (const entry of await readdir(currentPath, { withFileTypes: true })) {
      const childRelative = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name
      const childPath = join(currentPath, entry.name)
      if (entry.isDirectory()) await visit(childPath, childRelative)
      else if (entry.isFile()) {
        result.set(childRelative, await readFile(childPath, "utf8"))
      }
    }
  }

  try {
    await visit(rootPath, "")
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error
  }
  return result
}

function createIngestPrompt(input: {
  runId: string
  sourcePaths: readonly string[]
  instruction?: string
}): string {
  return `Maintain this wiki according to the loaded llm-wiki skill.

This is automated ingest run ${input.runId}. Skip discussion and perform the ingest now.

New immutable sources:
${input.sourcePaths.map((path) => `- ${path}`).join("\n")}

Requirements:
- Orient by reading SCHEMA.md, index.md, and recent log.md first.
- Never modify anything under raw/.
- Create or update useful wiki pages based on the sources.
- Keep page frontmatter, wikilinks, index.md, and log.md consistent.
- Use [[wikilinks]] only for existing or newly created wiki page slugs. Keep raw source paths as plain text.
- Append one ingest entry to log.md.
- Do not run Git or create commits; Amend owns Git history.
${input.instruction ? `\nAdditional direction:\n${input.instruction.trim()}\n` : ""}`
}

function createSchema(domain: string): string {
  return `# Wiki Schema

## Domain
${domain}

## Conventions
- File names use lowercase kebab-case.
- Every wiki page starts with YAML frontmatter.
- Wiki pages use [[wikilinks]] for real relationships.
- Wikilinks reference wiki page slugs only; raw source paths remain plain text.
- New pages are listed in index.md.
- Every action is appended to log.md.
- Raw sources are immutable.

## Required Frontmatter
- title
- created
- updated
- type: entity | concept | comparison | query
- tags
- sources

## Tag Taxonomy
- architecture
- concept
- performance
- reliability
- research
- storage

## Update Policy
Preserve conflicting positions, mark uncertainty, and never silently overwrite raw evidence.
`
}

function createIndex(): string {
  return `# Wiki Index

## Entities

## Concepts

## Comparisons

## Queries
`
}

function createLog(domain: string): string {
  return `# Wiki Log

## create | Wiki initialized
- Domain: ${domain}
`
}

function commitSubject(summary: string): string {
  const subject = summary.split("\n", 1)[0]?.trim() || "Update wiki"
  return subject.length <= 72 ? subject : `${subject.slice(0, 69)}...`
}

function validateRunId(runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{7,127}$/.test(runId)) {
    throw new Error("Invalid wiki run ID")
  }
  return runId
}

async function createTemporaryParent(): Promise<string> {
  const path = join(tmpdir(), `amend-wiki-run-${randomUUID()}`)
  await mkdir(path)
  return path
}

async function acquireLock(lockPath: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lock = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    }
    try {
      await writeFile(lockPath, `${JSON.stringify(lock)}\n`, {
        encoding: "utf8",
        flag: "wx",
      })
      return lock
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error
      if (attempt === 0 && (await isStaleLock(lockPath))) {
        await rm(lockPath, { force: true })
        continue
      }
      throw new Error("Wiki workspace is busy")
    }
  }
  throw new Error("Wiki workspace is busy")
}

async function releaseLock(
  lockPath: string,
  lock: Awaited<ReturnType<typeof acquireLock>>
): Promise<void> {
  const currentLock = await readLock(lockPath)
  if (currentLock?.token === lock.token) {
    await rm(lockPath, { force: true })
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  const lock = await readLock(lockPath)
  if (lock) {
    const age = Date.now() - Date.parse(lock.createdAt)
    if (Number.isFinite(age) && age > 24 * 60 * 60 * 1000) return true
    return !isProcessRunning(lock.pid)
  }
  const lockStat = await stat(lockPath).catch(() => undefined)
  if (!lockStat) return true
  return Date.now() - lockStat.mtimeMs > 24 * 60 * 60 * 1000
}

async function readLock(lockPath: string): Promise<
  | {
      version: 1
      pid: number
      token: string
      createdAt: string
    }
  | undefined
> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as {
      version?: unknown
      pid?: unknown
      token?: unknown
      createdAt?: unknown
    }
    if (
      value.version !== 1 ||
      !Number.isInteger(value.pid) ||
      typeof value.token !== "string" ||
      typeof value.createdAt !== "string"
    ) {
      return undefined
    }
    return value as {
      version: 1
      pid: number
      token: string
      createdAt: string
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isNodeError(error) || error.code !== "ESRCH"
  }
}

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["-C", cwd, ...arguments_],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(stderr.trim() || error.message, { cause: error })
          )
          return
        }
        resolvePromise(stdout.trim())
      }
    )
  })
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
