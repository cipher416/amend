import assert from "node:assert/strict"
import { describe, it } from "vitest"

import type { PiLoginEvent } from "@workspace/contract"

import { PiCredentialService } from "./pi-credential-service.ts"
import { WorkspaceServiceError } from "./workspace-service.ts"

describe("Pi credential service", () => {
  it("delegates status, provider, and model listings", async () => {
    const service = new PiCredentialService({
      status: async () => ({
        configured: true,
        provider: "zai",
        model: "glm-5-turbo",
      }),
      listApiKeyProviders: async () => [{ id: "zai", name: "ZAI" }],
      listModelsForProvider: async () => [
        { id: "glm-5-turbo", name: "GLM-5-Turbo" },
      ],
      isKnownProvider: async () => true,
    })

    assert.deepEqual(await service.status(), {
      configured: true,
      provider: "zai",
      model: "glm-5-turbo",
    })
    assert.deepEqual(await service.listApiKeyProviders(), [
      { id: "zai", name: "ZAI" },
    ])
    assert.deepEqual(await service.listModels("zai"), [
      { id: "glm-5-turbo", name: "GLM-5-Turbo" },
    ])
  })

  it("rejects credential and model operations for an unknown provider", async () => {
    const service = new PiCredentialService({
      isKnownProvider: async () => false,
    })

    await assert.rejects(
      service.listModels("nonsense"),
      (error: unknown) =>
        error instanceof WorkspaceServiceError && error.code === "invalid-input"
    )
    await assert.rejects(
      service.saveApiKeyCredential("nonsense", "sk-key"),
      (error: unknown) =>
        error instanceof WorkspaceServiceError && error.code === "invalid-input"
    )
  })

  it("saves an API key credential for a known provider", async () => {
    const saved: Array<{ provider: string; apiKey: string }> = []
    const service = new PiCredentialService({
      isKnownProvider: async () => true,
      saveApiKeyCredential: async (provider, apiKey) => {
        saved.push({ provider, apiKey })
      },
    })

    await service.saveApiKeyCredential("zai", "sk-test-key")

    assert.deepEqual(saved, [{ provider: "zai", apiKey: "sk-test-key" }])
  })

  it("rejects a default-model choice that the provider does not offer", async () => {
    const service = new PiCredentialService({
      isKnownProvider: async () => true,
      listModelsForProvider: async () => [
        { id: "glm-5-turbo", name: "GLM-5-Turbo" },
      ],
    })

    await assert.rejects(
      service.setDefaultModel("zai", "not-a-real-model"),
      (error: unknown) =>
        error instanceof WorkspaceServiceError && error.code === "invalid-input"
    )
  })

  it("writes the default model once it is confirmed to belong to the provider", async () => {
    const written: Array<{
      provider: string
      model: string
      thinking: string
    }> = []
    const service = new PiCredentialService({
      isKnownProvider: async () => true,
      listModelsForProvider: async () => [
        { id: "glm-5-turbo", name: "GLM-5-Turbo" },
      ],
      writeDefaultModel: async (settings) => {
        written.push(settings)
      },
    })

    await service.setDefaultModel("zai", "glm-5-turbo")

    assert.deepEqual(written, [
      { provider: "zai", model: "glm-5-turbo", thinking: "high" },
    ])
  })

  it("opens the browser, streams progress, bridges a prompt, and reports completion", async () => {
    const events: PiLoginEvent[] = []
    const openedUrls: string[] = []
    const service = new PiCredentialService({
      openExternal: async (url) => {
        openedUrls.push(url)
      },
      startOAuthLogin: async (_provider, callbacks) => {
        callbacks.onProgress?.("Starting")
        callbacks.onAuth({ url: "https://example.com/authorize" })
        const value = await callbacks.onPrompt({ message: "Paste the code" })
        assert.equal(value, "the-pasted-code")
      },
    })
    service.subscribeLoginEvents((event) => events.push(event))

    const { loginId } = service.startOAuthLogin("anthropic")

    assert.deepEqual(openedUrls, ["https://example.com/authorize"])
    assert.ok(
      events.some(
        (event) => event.type === "progress" && event.message === "Starting"
      )
    )
    assert.ok(events.some((event) => event.type === "auth"))
    const prompt = events.find((event) => event.type === "prompt")
    assert.ok(prompt)

    service.respondToPrompt(loginId, prompt.promptId, "the-pasted-code")
    await waitFor(() => events.some((event) => event.type === "completed"))

    assert.ok(events.some((event) => event.type === "completed"))
  })

  it("reports a real failure message with the pi-failed code, not a generic one", async () => {
    const events: PiLoginEvent[] = []
    const service = new PiCredentialService({
      startOAuthLogin: async () => {
        throw new Error("invalid_grant: the authorization code expired")
      },
    })
    service.subscribeLoginEvents((event) => events.push(event))

    service.startOAuthLogin("anthropic")
    await waitFor(() => events.some((event) => event.type === "failed"))

    const failure = events.find((event) => event.type === "failed")
    assert.ok(failure)
    assert.equal(failure.error.code, "pi-failed")
    assert.match(failure.error.message, /invalid_grant/)
  })

  it("cancels an in-progress login and rejects any pending prompt", async () => {
    const events: PiLoginEvent[] = []
    let capturedSignal: AbortSignal | undefined
    const service = new PiCredentialService({
      startOAuthLogin: async (_provider, callbacks) => {
        capturedSignal = callbacks.signal
        callbacks.onAuth({ url: "https://example.com/authorize" })
        await callbacks.onPrompt({ message: "Paste the code" })
      },
    })
    service.subscribeLoginEvents((event) => events.push(event))

    const { loginId } = service.startOAuthLogin("anthropic")
    service.cancelLogin(loginId)
    await waitFor(() => events.some((event) => event.type === "cancelled"))

    assert.equal(capturedSignal?.aborted, true)
    assert.ok(events.some((event) => event.type === "cancelled"))
    assert.equal(
      events.some((event) => event.type === "failed"),
      false
    )
  })

  it("rejects a stale or unknown prompt response", () => {
    const service = new PiCredentialService()

    assert.throws(
      () => service.respondToPrompt("no-such-login", "no-such-prompt", "value"),
      (error: unknown) =>
        error instanceof WorkspaceServiceError && error.code === "invalid-input"
    )
  })
})

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for the expected condition.")
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
