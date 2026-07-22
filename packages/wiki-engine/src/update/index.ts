import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

import { wikiPageDirectories } from "../internal/format.ts"
import { git } from "../internal/git.ts"
import { lintWikiStructure, readFilesUnder } from "../internal/validation.ts"
import type { WikiValidationDiagnostic } from "../internal/validation.ts"
import { resolveWikiPath } from "../wiki.ts"

export type WikiUpdateAgentEvent =
  | { type: "assistant-delta"; text: string }
  | {
      type: "tool-start"
      callId: string
      toolName: string
      input?: unknown
    }
  | {
      type: "tool-end"
      callId: string
      toolName: string
      isError: boolean
    }
  | { type: "validation"; status: "running" | "complete" | "failed" }
  | { type: "repair" }

export interface WikiUpdateAgentSession {
  readonly name: string
  prompt: (input: {
    workspacePath: string
    prompt: string
    lint: () => Promise<readonly WikiValidationDiagnostic[]>
    signal?: AbortSignal
    onEvent?: (event: WikiUpdateAgentEvent) => void
  }) => Promise<{
    output: string
    summary: string
    usage?: { inputTokens: number; outputTokens: number; cost: number }
  }>
  abort: () => Promise<void>
  dispose: () => void
}

export interface WikiUpdateChangedFile {
  path: string
  status: "added" | "modified" | "deleted"
  additions: number
  deletions: number
}

export interface WikiUpdateTurnResult {
  summary: string
  output: string
  changedFiles: readonly WikiUpdateChangedFile[]
  usage?: { inputTokens: number; outputTokens: number; cost: number }
}

export interface WikiUpdateCommitResult {
  runId: string
  baseCommit: string
  commitHash: string
  changedFiles: readonly string[]
  summary: string
  agent: string
}

export interface WikiUpdateProposalSession {
  readonly workspacePath: string
  readonly baseCommit: string
  readonly agentName: string
  runTurn: (input: {
    prompt: string
    contextPath?: string
    signal?: AbortSignal
    onEvent?: (event: WikiUpdateAgentEvent) => void
  }) => Promise<WikiUpdateTurnResult>
  readDiff: (path: string) => Promise<string>
  apply: () => Promise<WikiUpdateCommitResult>
  discard: () => Promise<void>
}

export interface WikiUpdateProposalOptions {
  workspacePath: string
  agent: WikiUpdateAgentSession
  createRunId?: () => string
  now?: () => Date
}

const allowedRootFiles = new Set(["index.md", "log.md"])

export async function createWikiUpdateProposalSession(
  options: WikiUpdateProposalOptions
): Promise<WikiUpdateProposalSession> {
  const workspacePath = await resolveWikiPath({
    wikiPath: options.workspacePath,
  })
  if (await git(workspacePath, "status", "--porcelain")) {
    throw new Error("Wiki must be clean")
  }
  const baseCommit = await git(workspacePath, "rev-parse", "HEAD")
  const temporaryParent = join(tmpdir(), `amend-wiki-update-${randomUUID()}`)
  const worktreePath = join(temporaryParent, "worktree")
  await mkdir(temporaryParent)
  try {
    await git(
      workspacePath,
      "worktree",
      "add",
      "--detach",
      worktreePath,
      baseCommit
    )
  } catch (error) {
    await rm(temporaryParent, { recursive: true, force: true })
    throw error
  }

  const gitControl = await readFile(join(worktreePath, ".git"), "utf8")
  const originalLog = await readFile(join(worktreePath, "log.md"), "utf8")
  const protectedRaw = await readFilesUnder(join(worktreePath, "raw"))
  const protectedSchema = await readFile(
    join(worktreePath, "SCHEMA.md"),
    "utf8"
  )
  const protectedAmend = await readFilesUnder(join(worktreePath, ".amend"))
  const createRunId = options.createRunId ?? randomUUID
  const now = options.now ?? (() => new Date())
  let disposed = false
  let running = false
  let summary: string | undefined
  let changedFiles: readonly WikiUpdateChangedFile[] = []

  async function lint(expectedLog: string) {
    const diagnostics = await lintWikiStructure(worktreePath)
    if ((await readFile(join(worktreePath, ".git"), "utf8")) !== gitControl) {
      diagnostics.push({
        code: "git.modified",
        message: "The update modified protected Git metadata",
      })
    }
    if (
      (await readFile(join(worktreePath, "SCHEMA.md"), "utf8").catch(
        () => undefined
      )) !== protectedSchema
    ) {
      diagnostics.push({
        code: "schema.modified",
        path: "SCHEMA.md",
        message: "The update modified the protected wiki schema",
      })
    }
    compareProtectedFiles(
      diagnostics,
      "raw",
      protectedRaw,
      await readFilesUnder(join(worktreePath, "raw"))
    )
    compareProtectedFiles(
      diagnostics,
      ".amend",
      protectedAmend,
      await readFilesUnder(join(worktreePath, ".amend"))
    )
    if (
      (await readFile(join(worktreePath, "log.md"), "utf8").catch(
        () => undefined
      )) !== expectedLog
    ) {
      diagnostics.push({
        code: "log.modified",
        path: "log.md",
        message: "Amend owns the append-only wiki log",
      })
    }
    for (const path of await changedPaths(worktreePath)) {
      if (!isAllowedUpdatePath(path)) {
        diagnostics.push({
          code: "path.unmanaged",
          path,
          message: "The update changed a protected or unmanaged path",
        })
      }
    }
    return uniqueDiagnostics(diagnostics)
  }

  async function runTurn(input: {
    prompt: string
    contextPath?: string
    signal?: AbortSignal
    onEvent?: (event: WikiUpdateAgentEvent) => void
  }): Promise<WikiUpdateTurnResult> {
    assertActive()
    if (running) throw new Error("A wiki update turn is already running")
    if (!input.prompt.trim()) throw new Error("Update prompt is required")
    running = true
    const checkpoint = await snapshotDraft(worktreePath)
    const expectedLog = await readFile(join(worktreePath, "log.md"), "utf8")
    try {
      const result = await options.agent.prompt({
        workspacePath: worktreePath,
        prompt: createUpdatePrompt(input.prompt, input.contextPath),
        signal: input.signal,
        onEvent: input.onEvent,
        lint: () => lint(expectedLog),
      })
      input.signal?.throwIfAborted()
      input.onEvent?.({ type: "validation", status: "running" })
      const diagnostics = await lint(expectedLog)
      input.onEvent?.({
        type: "validation",
        status: diagnostics.length > 0 ? "failed" : "complete",
      })
      if (diagnostics.length > 0)
        throw new WikiUpdateValidationError(diagnostics)
      summary = singleLineSummary(result.summary || result.output)
      await writeGeneratedLog(worktreePath, originalLog, summary, now())
      const finalDiagnostics = await lint(
        await readFile(join(worktreePath, "log.md"), "utf8")
      )
      if (finalDiagnostics.length > 0) {
        throw new WikiUpdateValidationError(finalDiagnostics)
      }
      changedFiles = await inspectChangedFiles(worktreePath)
      return {
        summary,
        output: result.output,
        changedFiles,
        ...(result.usage ? { usage: result.usage } : {}),
      }
    } catch (error) {
      await restoreDraft(worktreePath, checkpoint)
      throw error
    } finally {
      running = false
    }
  }

  async function readDiff(path: string): Promise<string> {
    assertActive()
    if (!changedFiles.some((file) => file.path === path)) {
      throw new Error("The file is not part of this update proposal")
    }
    return await git(worktreePath, "diff", "--no-color", "--", path)
  }

  async function apply(): Promise<WikiUpdateCommitResult> {
    assertActive()
    if (running) throw new Error("A wiki update turn is still running")
    if (!summary || changedFiles.length === 0) {
      throw new Error("The update has no changes to apply")
    }
    const diagnostics = await lint(
      await readFile(join(worktreePath, "log.md"), "utf8")
    )
    if (diagnostics.length > 0) throw new WikiUpdateValidationError(diagnostics)
    const lockPath = join(workspacePath, ".git/amend-run.lock")
    const lock = await acquireLock(lockPath)
    try {
      if (await git(workspacePath, "status", "--porcelain")) {
        throw new WikiUpdateConflictError("The wiki has uncommitted changes")
      }
      if ((await git(workspacePath, "rev-parse", "HEAD")) !== baseCommit) {
        throw new WikiUpdateConflictError(
          "The wiki changed after this update session started"
        )
      }
      const runId = validateRunId(createRunId())
      const manifestPath = `.amend/runs/${runId}.json`
      await mkdir(join(worktreePath, ".amend/runs"), { recursive: true })
      await writeFile(
        join(worktreePath, manifestPath),
        `${JSON.stringify(
          {
            version: 1,
            id: runId,
            kind: "update",
            createdAt: now().toISOString(),
            baseCommit,
            agent: options.agent.name,
            summary,
            changedFiles: changedFiles.map(({ path }) => path),
          },
          null,
          2
        )}\n`
      )
      await git(worktreePath, "add", "--all")
      await git(
        worktreePath,
        "commit",
        "-m",
        `${commitSubject(summary)}\n\nAmend-Run: ${runId}\nAgent: ${options.agent.name}`
      )
      const commitHash = await git(worktreePath, "rev-parse", "HEAD")
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
        await git(
          workspacePath,
          "update-ref",
          "refs/heads/main",
          baseCommit,
          commitHash
        ).catch(() => undefined)
        throw error
      }
      const result = {
        runId,
        baseCommit,
        commitHash,
        changedFiles: [...changedFiles.map(({ path }) => path), manifestPath],
        summary,
        agent: options.agent.name,
      }
      await cleanup()
      return result
    } finally {
      await releaseLock(lockPath, lock).catch(() => undefined)
    }
  }

  async function cleanup() {
    if (disposed) return
    disposed = true
    options.agent.dispose()
    await git(
      workspacePath,
      "worktree",
      "remove",
      "--force",
      worktreePath
    ).catch(() => undefined)
    await rm(temporaryParent, { recursive: true, force: true }).catch(
      () => undefined
    )
  }

  function assertActive() {
    if (disposed) throw new Error("The wiki update session is closed")
  }

  return {
    workspacePath,
    baseCommit,
    agentName: options.agent.name,
    runTurn,
    readDiff,
    apply,
    discard: cleanup,
  }
}

export class WikiUpdateValidationError extends Error {
  readonly diagnostics: readonly WikiValidationDiagnostic[]

  constructor(diagnostics: readonly WikiValidationDiagnostic[]) {
    super(
      `Wiki update validation failed:\n${diagnostics
        .map(
          ({ code, path, message }) =>
            `- [${code}]${path ? ` ${path}:` : ""} ${message}`
        )
        .join("\n")}`
    )
    this.name = "WikiUpdateValidationError"
    this.diagnostics = diagnostics
  }
}

export class WikiUpdateConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WikiUpdateConflictError"
  }
}

export class WikiUpdateAgentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "WikiUpdateAgentError"
  }
}

function compareProtectedFiles(
  diagnostics: WikiValidationDiagnostic[],
  root: string,
  expected: ReadonlyMap<string, string>,
  actual: ReadonlyMap<string, string>
) {
  const paths = new Set([...expected.keys(), ...actual.keys()])
  for (const path of paths) {
    if (expected.get(path) !== actual.get(path)) {
      diagnostics.push({
        code: `${root}.modified`,
        path: `${root}/${path}`,
        message: `The update modified protected ${root} content`,
      })
    }
  }
}

function isAllowedUpdatePath(path: string): boolean {
  return (
    allowedRootFiles.has(path) ||
    wikiPageDirectories.some((directory) =>
      new RegExp(`^${directory}/[a-z0-9]+(?:-[a-z0-9]+)*\\.md$`).test(path)
    )
  )
}

async function changedPaths(worktreePath: string): Promise<string[]> {
  const tracked = await git(worktreePath, "diff", "--name-only", "HEAD")
  const untracked = await git(
    worktreePath,
    "ls-files",
    "--others",
    "--exclude-standard"
  )
  return [...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean)
}

async function inspectChangedFiles(
  worktreePath: string
): Promise<WikiUpdateChangedFile[]> {
  const paths = await changedPaths(worktreePath)
  const untracked = new Set(
    (await git(worktreePath, "ls-files", "--others", "--exclude-standard"))
      .split("\n")
      .filter(Boolean)
  )
  if (untracked.size > 0) {
    await git(worktreePath, "add", "-N", "--", ...untracked)
  }
  const numstat = await git(worktreePath, "diff", "--numstat", "HEAD")
  const counts = new Map(
    numstat
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [added, deleted, path] = line.split("\t")
        return [
          path,
          { additions: Number(added) || 0, deletions: Number(deleted) || 0 },
        ]
      })
  )
  return await Promise.all(
    paths.map(async (path) => {
      const exists = await stat(join(worktreePath, path))
        .then((value) => value.isFile())
        .catch(() => false)
      const count = counts.get(path) ?? { additions: 0, deletions: 0 }
      return {
        path,
        status: untracked.has(path) ? "added" : exists ? "modified" : "deleted",
        ...count,
      }
    })
  )
}

async function writeGeneratedLog(
  worktreePath: string,
  originalLog: string,
  summary: string,
  date: Date
) {
  const changed = (await changedPaths(worktreePath)).filter(
    (path) => path !== "log.md"
  )
  if (changed.length === 0) {
    await writeFile(join(worktreePath, "log.md"), originalLog)
    return
  }
  const entry = `\n## ${date.toISOString().slice(0, 10)} | update | ${summary}\n${changed
    .map((path) => `- ${path}`)
    .join("\n")}\n`
  await writeFile(join(worktreePath, "log.md"), `${originalLog}${entry}`)
}

function createUpdatePrompt(prompt: string, contextPath?: string): string {
  return `Maintain this wiki according to the loaded llm-wiki skill.\n\nThe user requested an interactive wiki update. Inspect the wiki, make the requested changes now, and then explain the result.\n\nRequirements:\n- Never modify raw/, SCHEMA.md, log.md, .amend/, or Git metadata.\n- Only create, update, or delete wiki pages and keep index.md consistent.\n- Preserve provenance and do not invent unsupported facts.\n- Keep frontmatter, sources, tags, and wikilinks valid.\n- Do not run Git or create commits; Amend owns Git history.${
    contextPath ? `\n- The user opened this session from ${contextPath}.` : ""
  }\n\nUser request:\n${prompt.trim()}`
}

function singleLineSummary(value: string): string {
  const line = value
    .split("\n")
    .find((item) => item.trim())
    ?.replace(/^#+\s*/, "")
    .replaceAll("|", "-")
    .trim()
  return line ? line.slice(0, 240) : "Update wiki"
}

function commitSubject(summary: string): string {
  return summary.length <= 72 ? summary : `${summary.slice(0, 69)}...`
}

function validateRunId(runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{7,127}$/.test(runId)) {
    throw new Error("Invalid wiki update run ID")
  }
  return runId
}

function uniqueDiagnostics(
  diagnostics: readonly WikiValidationDiagnostic[]
): WikiValidationDiagnostic[] {
  const seen = new Set<string>()
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}\0${diagnostic.path ?? ""}\0${diagnostic.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function snapshotDraft(worktreePath: string) {
  return await readDraftFiles(worktreePath)
}

async function restoreDraft(
  worktreePath: string,
  snapshot: ReadonlyMap<string, Buffer>
) {
  const current = await readDraftFiles(worktreePath)
  for (const path of current.keys()) {
    if (!snapshot.has(path)) await rm(join(worktreePath, path), { force: true })
  }
  for (const [path, content] of snapshot) {
    const target = join(worktreePath, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
}

async function readDraftFiles(worktreePath: string) {
  const result = new Map<string, Buffer>()
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === worktreePath && entry.name === ".git") continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        result.set(relative(worktreePath, path), await readFile(path))
      }
    }
  }
  await visit(worktreePath)
  return result
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
      throw new Error("Wiki is busy")
    }
  }
  throw new Error("Wiki is busy")
}

async function releaseLock(
  lockPath: string,
  lock: Awaited<ReturnType<typeof acquireLock>>
) {
  const current = await readLock(lockPath)
  if (current?.token === lock.token) await rm(lockPath, { force: true })
}

async function isStaleLock(lockPath: string) {
  const lock = await readLock(lockPath)
  if (lock) {
    const age = Date.now() - Date.parse(lock.createdAt)
    if (Number.isFinite(age) && age > 86_400_000) return true
    try {
      process.kill(lock.pid, 0)
      return false
    } catch (error) {
      return isNodeError(error) && error.code === "ESRCH"
    }
  }
  const metadata = await stat(lockPath).catch(() => undefined)
  return !metadata || Date.now() - metadata.mtimeMs > 86_400_000
}

async function readLock(lockPath: string) {
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
