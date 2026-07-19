import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createPiWikiAgent, readPiAgentSettings } from "./pi-agent.ts"

const sdk = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
}))

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: { create: vi.fn(() => ({})) },
  createAgentSession: sdk.createAgentSession,
  createEditToolDefinition: vi.fn(() => createToolDefinition("edit")),
  createFindToolDefinition: vi.fn(() => createToolDefinition("find")),
  createGrepToolDefinition: vi.fn(() => createToolDefinition("grep")),
  createLsToolDefinition: vi.fn(() => createToolDefinition("ls")),
  createReadToolDefinition: vi.fn(() => createToolDefinition("read")),
  createWriteToolDefinition: vi.fn(() => createToolDefinition("write")),
  DefaultResourceLoader: class {
    async reload() {}
  },
  defineTool: vi.fn((tool) => tool),
  loadSkills: vi.fn(() => ({
    skills: [{ name: "llm-wiki" }],
    diagnostics: [],
  })),
  ModelRegistry: {
    create: vi.fn(() => ({ find: vi.fn(() => ({ id: "gpt-test" })) })),
  },
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { create: vi.fn(() => ({})) },
}))

describe("Pi wiki agent", () => {
  afterEach(() => {
    vi.useRealTimers()
    sdk.createAgentSession.mockReset()
  })

  it("runs an in-memory SDK session with the restricted wiki tools", async () => {
    const lint = vi.fn(async () => [])
    const runSession = vi.fn(async () => ({
      output: "Integrated both papers.",
      usage: { inputTokens: 120, outputTokens: 30, cost: 0.25 },
    }))
    const agent = createPiWikiAgent({
      provider: "openai-codex",
      model: "gpt-test",
      thinking: "high",
      skillPath: "/skills/llm-wiki/SKILL.md",
      runSession,
    })

    const result = await agent.run({
      workspacePath: "/wiki",
      runId: "019f7910-0000-7000-8000-000000000001",
      sourcePaths: ["raw/papers/paper.md"],
      prompt: "Maintain the wiki.",
      lint,
    })

    expect(runSession).toHaveBeenCalledWith({
      provider: "openai-codex",
      model: "gpt-test",
      thinking: "high",
      workspacePath: "/wiki",
      prompt: "Maintain the wiki.",
      tools: ["read", "edit", "write", "grep", "find", "ls"],
      skillPath: "/skills/llm-wiki/SKILL.md",
      timeoutMs: 10 * 60 * 1000,
      lint,
      maxRepairAttempts: 1,
      onProgress: undefined,
    })
    expect(agent.name).toBe("openai-codex/gpt-test")
    expect(result).toEqual({
      summary: "Integrated both papers.",
      output: "Integrated both papers.",
      usage: { inputTokens: 120, outputTokens: 30, cost: 0.25 },
    })
  })

  it("rejects a failed final assistant message", async () => {
    sdk.createAgentSession.mockResolvedValue({
      session: createSession({
        stopReason: "error",
        errorMessage: "Model request failed",
      }),
    })
    const agent = createPiWikiAgent({
      provider: "openai-codex",
      model: "gpt-test",
      skillPath: "/skills/llm-wiki/SKILL.md",
    })

    await expect(
      agent.run({
        workspacePath: "/wiki",
        runId: "019f7910-0000-7000-8000-000000000001",
        sourcePaths: ["raw/papers/paper.md"],
        prompt: "Maintain the wiki.",
        lint: vi.fn(async () => []),
      })
    ).rejects.toThrow("Model request failed")
  })

  it("rejects on timeout without waiting for abort to settle", async () => {
    vi.useFakeTimers()
    const abort = vi.fn(() => new Promise<void>(() => undefined))
    sdk.createAgentSession.mockResolvedValue({
      session: createSession({
        prompt: () => new Promise<void>(() => undefined),
        abort,
      }),
    })
    const agent = createPiWikiAgent({
      provider: "openai-codex",
      model: "gpt-test",
      skillPath: "/skills/llm-wiki/SKILL.md",
      timeoutMs: 100,
    })

    const run = agent.run({
      workspacePath: "/wiki",
      runId: "019f7910-0000-7000-8000-000000000001",
      sourcePaths: ["raw/papers/paper.md"],
      prompt: "Maintain the wiki.",
      lint: vi.fn(async () => []),
    })
    const rejection = expect(run).rejects.toThrow(
      "Pi run timed out after 100ms"
    )
    await vi.advanceTimersByTimeAsync(100)

    await rejection
    expect(abort).toHaveBeenCalledOnce()
  })

  it("feeds lint diagnostics back through the same session", async () => {
    const prompt = vi.fn(async (_prompt: string) => undefined)
    sdk.createAgentSession.mockResolvedValue({
      session: createSession({ prompt }),
    })
    const lint = vi
      .fn()
      .mockResolvedValueOnce([
        {
          code: "wikilink.broken",
          path: "concepts/attention.md",
          message: "Wikilink target does not exist: raw/papers/paper.md",
        },
      ])
      .mockResolvedValueOnce([])
    const agent = createPiWikiAgent({
      provider: "openai-codex",
      model: "gpt-test",
      skillPath: "/skills/llm-wiki/SKILL.md",
      maxRepairAttempts: 1,
    })

    await agent.run({
      workspacePath: "/wiki",
      runId: "019f7910-0000-7000-8000-000000000001",
      sourcePaths: ["raw/papers/paper.md"],
      prompt: "Maintain the wiki.",
      lint,
    })

    expect(prompt).toHaveBeenCalledTimes(2)
    expect(prompt).toHaveBeenNthCalledWith(1, "Maintain the wiki.")
    expect(prompt).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("[wikilink.broken]")
    )
    expect(lint).toHaveBeenCalledTimes(2)
    expect(sdk.createAgentSession).toHaveBeenCalledOnce()
  })

  it("rejects after the bounded repair attempt remains invalid", async () => {
    const prompt = vi.fn(async (_prompt: string) => undefined)
    sdk.createAgentSession.mockResolvedValue({
      session: createSession({ prompt }),
    })
    const lint = vi.fn(async () => [
      {
        code: "index.missing-page",
        path: "index.md",
        message: "The index is missing wiki page attention",
      },
    ])
    const agent = createPiWikiAgent({
      provider: "openai-codex",
      model: "gpt-test",
      skillPath: "/skills/llm-wiki/SKILL.md",
    })

    await expect(
      agent.run({
        workspacePath: "/wiki",
        runId: "019f7910-0000-7000-8000-000000000001",
        sourcePaths: ["raw/papers/paper.md"],
        prompt: "Maintain the wiki.",
        lint,
      })
    ).rejects.toThrow("[index.missing-page] index.md")
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(lint).toHaveBeenCalledTimes(2)
  })

  it("confines SDK file tools to the wiki workspace", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "amend-pi-workspace-"))
    if (process.platform !== "win32") {
      await symlink("/etc", join(workspacePath, "escape"))
    }
    sdk.createAgentSession.mockResolvedValue({
      session: createSession(),
    })
    const agent = createPiWikiAgent({
      provider: "openai-codex",
      model: "gpt-test",
      skillPath: "/skills/llm-wiki/SKILL.md",
    })

    await agent.run({
      workspacePath,
      runId: "019f7910-0000-7000-8000-000000000001",
      sourcePaths: ["raw/papers/paper.md"],
      prompt: "Maintain the wiki.",
      lint: vi.fn(async () => []),
    })

    const sessionOptions = sdk.createAgentSession.mock.calls[0]?.[0] as {
      noTools?: string
      customTools?: Array<{
        name: string
        execute: (...arguments_: unknown[]) => Promise<unknown>
      }>
    }
    const readTool = sessionOptions.customTools?.find(
      ({ name }) => name === "read"
    )
    expect(sessionOptions.noTools).toBe("builtin")
    expect(readTool).toBeDefined()
    await expect(
      readTool?.execute("call-1", { path: "/etc/passwd" })
    ).rejects.toThrow("outside the wiki workspace")
    if (process.platform !== "win32") {
      await expect(
        readTool?.execute("call-2", { path: "escape/passwd" })
      ).rejects.toThrow("must not traverse symbolic links")
    }
    await rm(workspacePath, { recursive: true, force: true })
  })

  it("defaults an omitted Pi thinking level", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amend-pi-settings-"))
    const settingsPath = join(directory, "settings.json")
    await writeFile(
      settingsPath,
      JSON.stringify({
        defaultProvider: "openai-codex",
        defaultModel: "gpt-test",
      })
    )

    await expect(readPiAgentSettings(settingsPath)).resolves.toEqual({
      provider: "openai-codex",
      model: "gpt-test",
      thinking: "high",
    })
    await rm(directory, { recursive: true, force: true })
  })
})

function createToolDefinition(name: string) {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    execute: vi.fn(async () => ({ content: [], details: undefined })),
  }
}

function createSession(
  options: {
    prompt?: (prompt: string) => Promise<void>
    abort?: () => Promise<void>
    stopReason?: "stop" | "error" | "aborted"
    errorMessage?: string
  } = {}
) {
  return {
    prompt: options.prompt ?? vi.fn(async () => undefined),
    abort: options.abort ?? vi.fn(async () => undefined),
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
    state: {
      messages: [
        {
          role: "assistant",
          stopReason: options.stopReason ?? "stop",
          errorMessage: options.errorMessage,
        },
      ],
    },
    getLastAssistantText: vi.fn(() => "Partial response"),
    getSessionStats: vi.fn(() => ({
      tokens: { input: 120, output: 30 },
      cost: 0.25,
    })),
  }
}
