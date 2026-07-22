import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import {
  AuthStorage,
  createAgentSession,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  defineTool,
  loadSkills,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import type {
  AgentSessionEvent,
  CreateAgentSessionOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import type { TSchema } from "typebox"

import { WikiLintError } from "../ingest/index.ts"
import type {
  WikiAgent,
  WikiAgentRunInput,
  WikiLintDiagnostic,
} from "../ingest/index.ts"
import type {
  WikiUpdateAgentEvent,
  WikiUpdateAgentSession,
} from "../update/index.ts"
import { WikiUpdateAgentError } from "../update/index.ts"

export type PiThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export interface PiAgentOptions {
  provider: string
  model: string
  thinking?: PiThinkingLevel
  skillPath: string
  timeoutMs?: number
  maxRepairAttempts?: number
  onProgress?: (event: PiProgressEvent) => void
  runSession?: PiSessionRunner
}

export type PiProgressEvent =
  | { type: "tool-start"; toolName: string }
  | { type: "tool-end"; toolName: string; isError: boolean }
  | { type: "turn-end" }
  | { type: "retry" }

export interface PiAgentSettings {
  provider: string
  model: string
  thinking: PiThinkingLevel
}

export interface PiReadOnlyInput {
  provider: string
  model: string
  thinking?: PiThinkingLevel
  workspacePath: string
  prompt: string
  timeoutMs?: number
  onProgress?: (event: PiProgressEvent) => void
  runSession?: PiSessionRunner
}

export interface PiSessionRunInput {
  provider: string
  model: string
  thinking: PiThinkingLevel
  workspacePath: string
  prompt: string
  tools: string[]
  skillPath?: string
  timeoutMs: number
  lint?: WikiAgentRunInput["lint"]
  maxRepairAttempts?: number
  onProgress?: (event: PiProgressEvent) => void
  signal?: AbortSignal
}

export interface PiSessionRunResult {
  output: string
  usage: { inputTokens: number; outputTokens: number; cost: number }
}

export type PiSessionRunner = (
  input: PiSessionRunInput
) => Promise<PiSessionRunResult>

export async function readPiAgentSettings(
  settingsPath = join(getAgentDirectory(), "settings.json")
): Promise<PiAgentSettings> {
  const value = JSON.parse(await readFile(settingsPath, "utf8")) as {
    defaultProvider?: unknown
    defaultModel?: unknown
    defaultThinkingLevel?: unknown
  }
  if (
    typeof value.defaultProvider !== "string" ||
    typeof value.defaultModel !== "string" ||
    (value.defaultThinkingLevel !== undefined &&
      !isThinkingLevel(value.defaultThinkingLevel))
  ) {
    throw new Error("Pi settings do not define a usable default model")
  }
  return {
    provider: value.defaultProvider,
    model: value.defaultModel,
    thinking: value.defaultThinkingLevel ?? "high",
  }
}

export function createPiWikiAgent(options: PiAgentOptions): WikiAgent {
  const runSession = options.runSession ?? runPiSession

  return {
    name: `${options.provider}/${options.model}`,
    async run(input) {
      const result = await runSession({
        provider: options.provider,
        model: options.model,
        thinking: options.thinking ?? "high",
        workspacePath: input.workspacePath,
        prompt: input.prompt,
        tools: ["read", "edit", "write", "grep", "find", "ls"],
        skillPath: options.skillPath,
        timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
        lint: input.lint,
        maxRepairAttempts: options.maxRepairAttempts ?? 1,
        onProgress: options.onProgress,
        signal: input.signal,
      })
      const summary =
        result.output
          .split("\n")
          .find((line) => line.trim())
          ?.trim() ||
        `Integrated ${input.sourcePaths.length} source${input.sourcePaths.length === 1 ? "" : "s"}`

      return { summary, output: result.output, usage: result.usage }
    },
  }
}

export function createPiWikiUpdateAgentSession(
  options: PiAgentOptions
): WikiUpdateAgentSession {
  let activeWorkspacePath: string | undefined
  let activeSession:
    Awaited<ReturnType<typeof createUpdatePiSession>> | undefined
  let disposed = false

  return {
    name: `${options.provider}/${options.model}`,
    async prompt(input) {
      if (disposed) throw new Error("Pi update session is closed")
      if (
        activeWorkspacePath !== undefined &&
        activeWorkspacePath !== input.workspacePath
      ) {
        throw new Error("Pi update session cannot change wiki worktrees")
      }
      activeWorkspacePath = input.workspacePath
      let unsubscribe: () => void = () => undefined
      try {
        activeSession ??= await createUpdatePiSession(
          options,
          input.workspacePath
        )
        const { session } = activeSession
        unsubscribe = session.subscribe((event) =>
          reportUpdateEvent(event, input.onEvent)
        )
        const deadline = Date.now() + (options.timeoutMs ?? 10 * 60 * 1000)
        let output = ""
        const maxRepairAttempts = options.maxRepairAttempts ?? 1
        for (let attempt = 0; ; attempt += 1) {
          input.signal?.throwIfAborted()
          const remainingMs = deadline - Date.now()
          if (remainingMs <= 0) {
            throw new Error(
              `Pi run timed out after ${options.timeoutMs ?? 10 * 60 * 1000}ms`
            )
          }
          await promptWithTimeout(
            session,
            attempt === 0
              ? input.prompt
              : createLintRepairPrompt(await input.lint()),
            remainingMs,
            options.timeoutMs ?? 10 * 60 * 1000,
            input.signal
          )
          output = getSuccessfulAssistantOutput(session)
          const diagnostics = await input.lint()
          input.signal?.throwIfAborted()
          if (diagnostics.length === 0) break
          if (attempt >= maxRepairAttempts) {
            throw new WikiLintError(diagnostics)
          }
          input.onEvent?.({ type: "repair" })
        }
        const stats = session.getSessionStats()
        return {
          output,
          summary:
            output
              .split("\n")
              .find((line) => line.trim())
              ?.replace(/^#+\s*/, "")
              .trim() || "Update wiki",
          usage: {
            inputTokens: stats.tokens.input,
            outputTokens: stats.tokens.output,
            cost: stats.cost,
          },
        }
      } catch (error) {
        if (isAbortError(error) || error instanceof WikiLintError) throw error
        throw new WikiUpdateAgentError(
          error instanceof Error ? error.message : "Pi update session failed",
          { cause: error }
        )
      } finally {
        unsubscribe()
      }
    },
    async abort() {
      await activeSession?.session.abort().catch(() => undefined)
    },
    dispose() {
      if (disposed) return
      disposed = true
      activeSession?.session.dispose()
      activeSession = undefined
    },
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  )
}

async function createUpdatePiSession(
  options: PiAgentOptions,
  workspacePath: string
) {
  const agentDir = getAgentDirectory()
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"))
  const modelRegistry = ModelRegistry.create(
    authStorage,
    join(agentDir, "models.json")
  )
  const model = modelRegistry.find(options.provider, options.model)
  if (!model)
    throw new Error(`Pi model not found: ${options.provider}/${options.model}`)
  const settingsManager = SettingsManager.create(workspacePath, agentDir)
  const skills = loadSkills({
    cwd: workspacePath,
    agentDir,
    skillPaths: [options.skillPath],
    includeDefaults: false,
  })
  if (skills.skills.length !== 1) {
    throw new Error(`Could not load Pi skill: ${options.skillPath}`)
  }
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspacePath,
    agentDir,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    skillsOverride: () => skills,
  })
  await resourceLoader.reload()
  return await createAgentSession({
    cwd: workspacePath,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: options.thinking ?? "high",
    tools: ["read", "edit", "write", "grep", "find", "ls"],
    noTools: "builtin",
    customTools: createConfinedTools(workspacePath, [
      "read",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]),
    resourceLoader,
    sessionManager: SessionManager.inMemory(workspacePath),
    settingsManager,
  })
}

function reportUpdateEvent(
  event: AgentSessionEvent,
  onEvent?: (event: WikiUpdateAgentEvent) => void
) {
  if (!onEvent) return
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    onEvent({
      type: "assistant-delta",
      text: event.assistantMessageEvent.delta,
    })
  } else if (event.type === "tool_execution_start") {
    onEvent({
      type: "tool-start",
      callId: event.toolCallId,
      toolName: event.toolName,
      input: event.args,
    })
  } else if (event.type === "tool_execution_end") {
    onEvent({
      type: "tool-end",
      callId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
    })
  }
}

export async function runPiReadOnly(input: PiReadOnlyInput): Promise<{
  output: string
  usage: { inputTokens: number; outputTokens: number; cost: number }
}> {
  return await (input.runSession ?? runPiSession)({
    provider: input.provider,
    model: input.model,
    thinking: input.thinking ?? "high",
    workspacePath: input.workspacePath,
    prompt: input.prompt,
    tools: ["read", "grep", "find", "ls"],
    timeoutMs: input.timeoutMs ?? 10 * 60 * 1000,
    onProgress: input.onProgress,
  })
}

async function runPiSession(
  input: PiSessionRunInput
): Promise<PiSessionRunResult> {
  input.signal?.throwIfAborted()
  const agentDir = getAgentDirectory()
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"))
  const modelRegistry = ModelRegistry.create(
    authStorage,
    join(agentDir, "models.json")
  )
  const model = modelRegistry.find(input.provider, input.model)
  if (!model)
    throw new Error(`Pi model not found: ${input.provider}/${input.model}`)

  const settingsManager = SettingsManager.create(input.workspacePath, agentDir)
  const skills = input.skillPath
    ? loadSkills({
        cwd: input.workspacePath,
        agentDir,
        skillPaths: [input.skillPath],
        includeDefaults: false,
      })
    : undefined
  if (input.skillPath && skills?.skills.length !== 1) {
    throw new Error(`Could not load Pi skill: ${input.skillPath}`)
  }
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.workspacePath,
    agentDir,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    noSkills: !skills,
    ...(skills
      ? {
          skillsOverride: () => skills,
        }
      : {}),
  })
  await resourceLoader.reload()

  const { session } = await createAgentSession({
    cwd: input.workspacePath,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: input.thinking,
    tools: input.tools,
    noTools: "builtin",
    customTools: createConfinedTools(input.workspacePath, input.tools),
    resourceLoader,
    sessionManager: SessionManager.inMemory(input.workspacePath),
    settingsManager,
  })
  const unsubscribe = session.subscribe((event) =>
    reportProgress(event, input.onProgress)
  )

  try {
    const deadline = Date.now() + input.timeoutMs
    const maxRepairAttempts = input.maxRepairAttempts ?? 0
    if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0) {
      throw new Error("Pi max repair attempts must be a non-negative integer")
    }
    let prompt = input.prompt
    let output = ""

    for (let attempt = 0; ; attempt += 1) {
      input.signal?.throwIfAborted()
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        void session.abort().catch(() => undefined)
        throw new Error(`Pi run timed out after ${input.timeoutMs}ms`)
      }
      await promptWithTimeout(
        session,
        prompt,
        remainingMs,
        input.timeoutMs,
        input.signal
      )
      output = getSuccessfulAssistantOutput(session)
      const diagnostics = input.lint ? await input.lint() : []
      input.signal?.throwIfAborted()
      if (diagnostics.length === 0) break
      if (attempt >= maxRepairAttempts) {
        throw new WikiLintError(diagnostics)
      }
      prompt = createLintRepairPrompt(diagnostics)
    }

    const stats = session.getSessionStats()
    return {
      output,
      usage: {
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        cost: stats.cost,
      },
    }
  } finally {
    unsubscribe()
    session.dispose()
  }
}

async function promptWithTimeout(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  prompt: string,
  timeoutMs: number,
  reportedTimeoutMs = timeoutMs,
  signal?: AbortSignal
): Promise<void> {
  let onAbort: (() => void) | undefined
  let interrupted = false
  let rejectInterruption: ((error: Error) => void) | undefined
  const promptPromise = session.prompt(prompt)
  const interruptionPromise = new Promise<never>((_, reject) => {
    rejectInterruption = reject
  })
  const interrupt = (error: Error) => {
    if (interrupted) return
    interrupted = true
    void (async () => {
      await session.abort().catch(() => undefined)
      await promptPromise.catch(() => undefined)
      rejectInterruption?.(error)
    })()
  }
  const timeout = setTimeout(() => {
    interrupt(new Error(`Pi run timed out after ${reportedTimeoutMs}ms`))
  }, timeoutMs)
  timeout.unref()
  if (signal) {
    onAbort = () => interrupt(abortReason(signal))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  const guardedPrompt = promptPromise.then(
    () => (interrupted ? interruptionPromise : undefined),
    (error: unknown) => {
      if (interrupted) return interruptionPromise
      throw error
    }
  )

  try {
    await Promise.race([guardedPrompt, interruptionPromise])
  } finally {
    clearTimeout(timeout)
    if (onAbort) signal?.removeEventListener("abort", onAbort)
  }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException("The operation was aborted", "AbortError")
}

function getSuccessfulAssistantOutput(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"]
): string {
  const lastAssistantMessage = [...session.state.messages]
    .reverse()
    .find((message) => message.role === "assistant")
  if (
    lastAssistantMessage?.stopReason === "error" ||
    lastAssistantMessage?.stopReason === "aborted"
  ) {
    throw new Error(
      lastAssistantMessage.errorMessage ??
        `Pi run ${lastAssistantMessage.stopReason}`
    )
  }
  const output = session.getLastAssistantText()?.trim()
  if (!output) throw new Error("Pi returned no final response")
  return output
}

function createLintRepairPrompt(
  diagnostics: readonly WikiLintDiagnostic[]
): string {
  return `The deterministic wiki linter rejected the current wiki. Fix every diagnostic below, then finish the ingest. Do not modify raw sources or create Git commits.

${diagnostics
  .map(
    ({ code, message, path }) =>
      `- [${code}]${path ? ` ${path}:` : ""} ${message}`
  )
  .join("\n")}`
}

function createConfinedTools(
  workspacePath: string,
  toolNames: readonly string[]
): NonNullable<CreateAgentSessionOptions["customTools"]> {
  return toolNames.map((name) => {
    switch (name) {
      case "read":
        return confineTool(
          createReadToolDefinition(workspacePath),
          workspacePath
        )
      case "edit":
        return confineTool(
          createEditToolDefinition(workspacePath),
          workspacePath
        )
      case "write":
        return confineTool(
          createWriteToolDefinition(workspacePath),
          workspacePath
        )
      case "grep":
        return confineTool(
          createGrepToolDefinition(workspacePath),
          workspacePath
        )
      case "find":
        return confineTool(
          createFindToolDefinition(workspacePath),
          workspacePath
        )
      case "ls":
        return confineTool(createLsToolDefinition(workspacePath), workspacePath)
      default:
        throw new Error(`Unsupported confined Pi tool: ${name}`)
    }
  })
}

function confineTool<TParameters extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParameters, TDetails, TState>,
  workspacePath: string
) {
  return defineTool({
    ...tool,
    async execute(toolCallId, parameters, signal, onUpdate, context) {
      const pathInput = getToolPath(parameters)
      const { relativePath, targetPath } = await assertWorkspacePath(
        workspacePath,
        pathInput
      )
      if (tool.name === "read") {
        await lstat(targetPath).catch((error: unknown) => {
          throw new Error(`Pi tool path does not exist: ${pathInput}`, {
            cause: error,
          })
        })
      }
      return await tool.execute(
        toolCallId,
        withToolPath(parameters, relativePath),
        signal,
        onUpdate,
        context
      )
    },
  })
}

function getToolPath(parameters: unknown): string {
  if (
    typeof parameters !== "object" ||
    parameters === null ||
    !("path" in parameters) ||
    parameters.path === undefined
  ) {
    return "."
  }
  if (typeof parameters.path !== "string") {
    throw new Error("Pi tool path must be a string")
  }
  return parameters.path
}

async function assertWorkspacePath(
  workspacePath: string,
  pathInput: string
): Promise<{ relativePath: string; targetPath: string }> {
  if (
    pathInput.includes("\0") ||
    pathInput.startsWith("~") ||
    pathInput.startsWith("@")
  ) {
    throw new Error(`Pi tool path is outside the wiki: ${pathInput}`)
  }
  const normalizedInput = normalizePiToolPath(pathInput)
  const rootPath = await realpath(workspacePath)
  const targetPath = resolve(rootPath, normalizedInput)
  const relativePath = relative(rootPath, targetPath)
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Pi tool path is outside the wiki: ${pathInput}`)
  }
  if (relativePath === ".git" || relativePath.startsWith(`.git${sep}`)) {
    throw new Error(`Pi tool path is protected Git metadata: ${pathInput}`)
  }

  let currentPath = rootPath
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    currentPath = join(currentPath, segment)
    const stats = await lstat(currentPath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return undefined
      throw error
    })
    if (!stats) break
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Pi tool path must not traverse symbolic links: ${pathInput}`
      )
    }
  }
  return { relativePath: relativePath || ".", targetPath }
}

function normalizePiToolPath(pathInput: string): string {
  const normalized = pathInput.replace(
    /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g,
    " "
  )
  if (!/^file:\/\//.test(normalized)) return normalized
  try {
    return fileURLToPath(normalized)
  } catch (error) {
    throw new Error(`Pi tool path is outside the wiki: ${pathInput}`, {
      cause: error,
    })
  }
}

function withToolPath<T>(parameters: T, path: string): T {
  if (typeof parameters !== "object" || parameters === null) return parameters
  return { ...parameters, path }
}

function reportProgress(
  event: AgentSessionEvent,
  onProgress?: (event: PiProgressEvent) => void
): void {
  if (!onProgress) return
  if (event.type === "tool_execution_start") {
    onProgress({ type: "tool-start", toolName: event.toolName })
  } else if (event.type === "tool_execution_end") {
    onProgress({
      type: "tool-end",
      toolName: event.toolName,
      isError: event.isError,
    })
  } else if (event.type === "turn_end") {
    onProgress({ type: "turn-end" })
  } else if (event.type === "auto_retry_start") {
    onProgress({ type: "retry" })
  }
}

export function getAgentDirectory(): string {
  return resolve(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent")
  )
}

/**
 * Persist the default provider/model/thinking level to settings.json,
 * preserving any other keys already present (e.g. theme, changelog state).
 */
export async function writePiAgentSettings(
  settings: PiAgentSettings,
  settingsPath = join(getAgentDirectory(), "settings.json")
): Promise<void> {
  const existing: Record<string, unknown> = await readFile(settingsPath, "utf8")
    .then((raw) => JSON.parse(raw) as Record<string, unknown>)
    .catch(() => ({}))
  const next = {
    ...existing,
    defaultProvider: settings.provider,
    defaultModel: settings.model,
    defaultThinkingLevel: settings.thinking,
  }
  await mkdir(dirname(settingsPath), { recursive: true })
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8")
}

function isThinkingLevel(value: unknown): value is PiThinkingLevel {
  return (
    typeof value === "string" &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
  )
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
