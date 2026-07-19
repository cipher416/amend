import { lstat, readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

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

import { WikiLintError } from "./wiki-engine.ts"
import type {
  WikiAgent,
  WikiAgentRunInput,
  WikiLintDiagnostic,
} from "./wiki-engine.ts"

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
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        void session.abort().catch(() => undefined)
        throw new Error(`Pi run timed out after ${input.timeoutMs}ms`)
      }
      await promptWithTimeout(session, prompt, remainingMs, input.timeoutMs)
      output = getSuccessfulAssistantOutput(session)
      const diagnostics = input.lint ? await input.lint() : []
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
  reportedTimeoutMs = timeoutMs
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Pi run timed out after ${reportedTimeoutMs}ms`))
      void session.abort().catch(() => undefined)
    }, timeoutMs)
    timeout.unref()
  })

  try {
    await Promise.race([session.prompt(prompt), timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
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
  return `The deterministic wiki linter rejected the current workspace. Fix every diagnostic below, then finish the ingest. Do not modify raw sources or create Git commits.

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
      await assertWorkspacePath(workspacePath, getToolPath(parameters))
      return await tool.execute(
        toolCallId,
        parameters,
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
): Promise<void> {
  if (
    pathInput.includes("\0") ||
    pathInput.startsWith("~") ||
    pathInput.startsWith("@")
  ) {
    throw new Error(`Pi tool path is outside the wiki workspace: ${pathInput}`)
  }
  const rootPath = await realpath(workspacePath)
  const targetPath = resolve(rootPath, pathInput)
  const relativePath = relative(rootPath, targetPath)
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Pi tool path is outside the wiki workspace: ${pathInput}`)
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

function getAgentDirectory(): string {
  return resolve(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent")
  )
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
