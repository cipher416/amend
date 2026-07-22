import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createPiWikiAgent,
  createPiWikiUpdateAgentSession,
  readPiAgentSettings,
} from "./pi.ts"

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
      writePolicy: "ingest",
      skillPath: "/skills/llm-wiki/SKILL.md",
      timeoutMs: 10 * 60 * 1000,
      lint,
      maxRepairAttempts: 1,
      onProgress: undefined,
      signal: undefined,
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

  it("waits for the active Pi prompt to settle after a timeout", async () => {
    vi.useFakeTimers()
    let rejectPrompt: ((error: Error) => void) | undefined
    const abort = vi.fn(async () => {
      rejectPrompt?.(new DOMException("Aborted", "AbortError"))
    })
    sdk.createAgentSession.mockResolvedValue({
      session: createSession({
        prompt: () =>
          new Promise<void>((_resolve, reject) => {
            rejectPrompt = reject
          }),
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

  it("aborts the active Pi prompt when the caller cancels", async () => {
    let rejectPrompt: ((error: Error) => void) | undefined
    const abort = vi.fn(async () => {
      rejectPrompt?.(new DOMException("Aborted", "AbortError"))
    })
    let markPromptStarted: (() => void) | undefined
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve
    })
    sdk.createAgentSession.mockResolvedValue({
      session: createSession({
        prompt: () => {
          markPromptStarted?.()
          return new Promise<void>((_resolve, reject) => {
            rejectPrompt = reject
          })
        },
        abort,
      }),
    })
    const controller = new AbortController()
    const agent = createPiWikiAgent({
      provider: "openai-codex",
      model: "gpt-test",
      skillPath: "/skills/llm-wiki/SKILL.md",
    })

    const run = agent.run({
      workspacePath: "/wiki",
      runId: "019f7910-0000-7000-8000-000000000001",
      sourcePaths: ["raw/papers/paper.md"],
      prompt: "Maintain the wiki.",
      lint: vi.fn(async () => []),
      signal: controller.signal,
    })
    await promptStarted
    controller.abort()

    await expect(run).rejects.toMatchObject({ name: "AbortError" })
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
    expect(prompt).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("finish the ingest")
    )
    expect(lint).toHaveBeenCalledTimes(2)
    expect(sdk.createAgentSession).toHaveBeenCalledOnce()
  })

  it("gives update repairs mode-specific actions for every diagnostic", async () => {
    const prompt = vi.fn(async (_prompt: string) => undefined)
    sdk.createAgentSession.mockResolvedValue({
      session: createSession({ prompt }),
    })
    const lint = vi
      .fn()
      .mockResolvedValueOnce([
        {
          code: "path.unmanaged",
          path: "root-page.md",
          message: "The update changed an unmanaged path",
        },
        {
          code: "index.missing",
          path: "index.md",
          message: "The wiki index is missing",
        },
        {
          code: "page.duplicate-slug",
          message: "The page slug is duplicated",
        },
        {
          code: "frontmatter.missing-source",
          path: "concepts/attention.md",
          message: "The cited source is missing",
        },
        {
          code: "raw.modified",
          path: "raw/articles/source.md",
          message: "The update modified protected raw content",
        },
      ])
      .mockResolvedValueOnce([])
    const agent = createPiWikiUpdateAgentSession({
      provider: "openai-codex",
      model: "gpt-test",
      skillPath: "/skills/llm-wiki/SKILL.md",
    })

    await agent.prompt({
      workspacePath: "/wiki",
      prompt: "Maintain the wiki.",
      lint,
    })

    const repairPrompt = prompt.mock.calls[1]?.[0]
    expect(repairPrompt).toContain("finish the update")
    expect(repairPrompt).not.toContain("finish the ingest")
    expect(repairPrompt).toContain("Move the page to a managed directory")
    expect(repairPrompt).toContain("Recreate index.md")
    expect(repairPrompt).toContain("Choose one canonical page slug")
    expect(repairPrompt).toContain("Correct or remove missing source paths")
    expect(repairPrompt).toContain("Restore protected content")
    agent.dispose()
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

  it("confines SDK file tools to the wiki", async () => {
    const parent = await mkdtemp(join(tmpdir(), "amend-pi-workspace-"))
    const workspacePath = join(parent, "wiki\u00a0space")
    await mkdir(workspacePath)
    await writeFile(join(workspacePath, "inside.md"), "safe")
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
      readTool?.execute("call-safe", { path: "inside.md" })
    ).resolves.toBeDefined()
    await expect(
      readTool?.execute("call-1", { path: "/etc/passwd" })
    ).rejects.toThrow("outside the wiki")
    await expect(
      readTool?.execute("call-file-url", { path: "file:///etc/passwd" })
    ).rejects.toThrow("outside the wiki")
    await expect(
      readTool?.execute("call-git", { path: ".git" })
    ).rejects.toThrow("protected Git metadata")
    if (process.platform !== "win32") {
      await expect(
        readTool?.execute("call-2", { path: "escape/passwd" })
      ).rejects.toThrow("must not traverse symbolic links")
    }
    await rm(parent, { recursive: true, force: true })
  })

  it("rejects ingest writes outside managed wiki paths", async () => {
    const parent = await mkdtemp(join(tmpdir(), "amend-pi-write-policy-"))
    const workspacePath = join(parent, "wiki")
    await mkdir(workspacePath)
    sdk.createAgentSession.mockImplementation(async (sessionOptions) => {
      const writeTool = sessionOptions.customTools?.find(
        ({ name }: { name: string }) => name === "write"
      )
      return {
        session: createSession({
          prompt: async () => {
            await writeTool?.execute("call-root-write", {
              path: "transformer-architecture.md",
              content: "invalid root page",
            })
          },
        }),
      }
    })
    const agent = createPiWikiAgent({
      provider: "openai-codex",
      model: "gpt-test",
      skillPath: "/skills/llm-wiki/SKILL.md",
    })

    await expect(
      agent.run({
        workspacePath,
        runId: "019f7910-0000-7000-8000-000000000001",
        sourcePaths: ["raw/papers/paper.md"],
        prompt: "Maintain the wiki.",
        lint: vi.fn(async () => []),
      })
    ).rejects.toThrow("transformer-architecture.md")
    await rm(parent, { recursive: true, force: true })
  })

  it("enforces update ownership for edit, write, and delete tools", async () => {
    const parent = await mkdtemp(join(tmpdir(), "amend-pi-update-policy-"))
    const workspacePath = join(parent, "wiki")
    await mkdir(join(workspacePath, "concepts"), { recursive: true })
    await mkdir(join(workspacePath, "raw/articles"), { recursive: true })
    await mkdir(join(workspacePath, ".amend"), { recursive: true })
    await writeFile(join(workspacePath, "concepts/attention.md"), "managed")
    await writeFile(join(workspacePath, "index.md"), "index")
    await writeFile(join(workspacePath, "log.md"), "log")
    await writeFile(join(workspacePath, "SCHEMA.md"), "schema")
    await writeFile(join(workspacePath, "raw/articles/source.md"), "raw")
    await writeFile(join(workspacePath, ".amend/wiki.json"), "{}")
    sdk.createAgentSession.mockResolvedValue({ session: createSession() })
    const agent = createPiWikiUpdateAgentSession({
      provider: "openai-codex",
      model: "gpt-test",
      skillPath: "/skills/llm-wiki/SKILL.md",
    })
    await agent.prompt({
      workspacePath,
      prompt: "Maintain the wiki.",
      lint: vi.fn(async () => []),
    })
    const sessionOptions = sdk.createAgentSession.mock.calls[0]?.[0] as {
      customTools?: Array<{
        name: string
        execute: (...arguments_: unknown[]) => Promise<unknown>
      }>
    }
    const editTool = sessionOptions.customTools?.find(
      ({ name }) => name === "edit"
    )
    const writeTool = sessionOptions.customTools?.find(
      ({ name }) => name === "write"
    )
    const deleteTool = sessionOptions.customTools?.find(
      ({ name }) => name === "delete"
    )

    for (const tool of [editTool, writeTool]) {
      await expect(
        tool?.execute("call-managed", { path: "concepts/attention.md" })
      ).resolves.toBeDefined()
      await expect(
        tool?.execute("call-index", { path: "index.md" })
      ).resolves.toBeDefined()
      for (const path of [
        "root-page.md",
        "raw/articles/source.md",
        "SCHEMA.md",
        "log.md",
        ".amend/wiki.json",
      ]) {
        await expect(
          tool?.execute(`call-reject-${path}`, { path })
        ).rejects.toThrow(path)
      }
    }
    for (const path of ["index.md", "root-page.md", "raw/articles/source.md"]) {
      await expect(
        deleteTool?.execute(`call-reject-delete-${path}`, { path })
      ).rejects.toThrow(path)
    }

    agent.dispose()
    await rm(parent, { recursive: true, force: true })
  })

  it("lets update sessions delete managed wiki pages", async () => {
    const parent = await mkdtemp(join(tmpdir(), "amend-pi-delete-policy-"))
    const workspacePath = join(parent, "wiki")
    await mkdir(join(workspacePath, "concepts"), { recursive: true })
    const pagePath = join(workspacePath, "concepts/obsolete-page.md")
    await writeFile(pagePath, "obsolete")
    sdk.createAgentSession.mockImplementation(async (sessionOptions) => {
      const deleteTool = sessionOptions.customTools?.find(
        ({ name }: { name: string }) => name === "delete"
      )
      return {
        session: createSession({
          prompt: async () => {
            await deleteTool?.execute("call-delete", {
              path: "concepts/obsolete-page.md",
            })
          },
        }),
      }
    })
    const agent = createPiWikiUpdateAgentSession({
      provider: "openai-codex",
      model: "gpt-test",
      skillPath: "/skills/llm-wiki/SKILL.md",
    })

    await agent.prompt({
      workspacePath,
      prompt: "Delete the obsolete page.",
      lint: vi.fn(async () => []),
    })

    await expect(readFile(pagePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    })
    agent.dispose()
    await rm(parent, { recursive: true, force: true })
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
