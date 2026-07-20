import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readPiAgentSettings, writePiAgentSettings } from "./pi.ts"
import {
  isKnownProvider,
  isPiOAuthProviderId,
  listApiKeyProviders,
  listModelsForProvider,
  readPiConnectionStatus,
  saveApiKeyCredential,
} from "./pi-credentials.ts"

let agentDirectory: string
let originalAgentDirectoryEnvironment: string | undefined

beforeEach(async () => {
  originalAgentDirectoryEnvironment = process.env.PI_CODING_AGENT_DIR
  agentDirectory = await mkdtemp(join(tmpdir(), "amend-pi-credentials-"))
  process.env.PI_CODING_AGENT_DIR = agentDirectory
})

afterEach(async () => {
  if (originalAgentDirectoryEnvironment === undefined) {
    delete process.env.PI_CODING_AGENT_DIR
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDirectoryEnvironment
  }
  await rm(agentDirectory, { recursive: true, force: true })
})

describe("Pi credentials", () => {
  it("only offers the dedicated OAuth flow for anthropic and openai-codex", () => {
    expect(isPiOAuthProviderId("anthropic")).toBe(true)
    expect(isPiOAuthProviderId("openai-codex")).toBe(true)
    expect(isPiOAuthProviderId("github-copilot")).toBe(false)
    expect(isPiOAuthProviderId("zai")).toBe(false)
  })

  it("excludes the OAuth-only providers from the generic API-key list", () => {
    const providers = listApiKeyProviders()
    expect(providers.length).toBeGreaterThan(0)
    expect(providers.some((provider) => provider.id === "anthropic")).toBe(
      false
    )
    expect(providers.some((provider) => provider.id === "openai-codex")).toBe(
      false
    )
    expect(providers.some((provider) => provider.id === "zai")).toBe(true)
    // Sorted by display name for a stable, scannable picker.
    const names = providers.map((provider) => provider.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })

  it("lists models scoped to a single provider", () => {
    const models = listModelsForProvider("zai")
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((model) => model.id && model.name)).toBe(true)
  })

  it("recognizes known and unknown providers", () => {
    expect(isKnownProvider("zai")).toBe(true)
    expect(isKnownProvider("not-a-real-provider")).toBe(false)
  })

  it("reports not configured before any settings or credentials exist", async () => {
    expect(await readPiConnectionStatus()).toEqual({ configured: false })
  })

  it("reports not configured when settings name a provider with no credential", async () => {
    await writePiAgentSettings({
      provider: "zai",
      model: "glm-5-turbo",
      thinking: "high",
    })

    expect(await readPiConnectionStatus()).toEqual({
      configured: false,
      provider: "zai",
      model: "glm-5-turbo",
    })
  })

  it("reports configured once a credential is saved for the default provider", async () => {
    await writePiAgentSettings({
      provider: "zai",
      model: "glm-5-turbo",
      thinking: "high",
    })
    saveApiKeyCredential("zai", "sk-test-key")

    expect(await readPiConnectionStatus()).toEqual({
      configured: true,
      provider: "zai",
      model: "glm-5-turbo",
    })
  })

  it("preserves unrelated settings.json keys when writing the default model", async () => {
    const settingsPath = join(agentDirectory, "settings.json")
    await writeFile(
      settingsPath,
      JSON.stringify({ theme: "dark", lastChangelogVersion: "0.80.6" })
    )

    await writePiAgentSettings(
      { provider: "openai", model: "gpt-4.1", thinking: "medium" },
      settingsPath
    )

    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
      string,
      unknown
    >
    expect(raw).toMatchObject({
      theme: "dark",
      lastChangelogVersion: "0.80.6",
      defaultProvider: "openai",
      defaultModel: "gpt-4.1",
      defaultThinkingLevel: "medium",
    })
    await expect(readPiAgentSettings(settingsPath)).resolves.toEqual({
      provider: "openai",
      model: "gpt-4.1",
      thinking: "medium",
    })
  })
})
