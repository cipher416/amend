import { randomUUID } from "node:crypto"

import type {
  PiConnectionStatus,
  PiLoginEvent,
  PiModelSummary,
  PiOAuthProviderId,
  PiProviderSummary,
} from "@workspace/contract"
import type { OAuthLoginCallbacks } from "@workspace/wiki-engine/agent/pi-credentials"
import { shell } from "electron"

import { WorkspaceServiceError } from "./workspace-service"

// The Pi SDK is loaded lazily (mirroring workspace-service.ts's dynamic
// `@workspace/wiki-engine/agent/pi` import) so test doubles never have to
// pull in the real SDK, and its module resolution cost is only paid once a
// user actually connects a provider. Dynamic import() of the same specifier
// is cached by the module system, so repeated calls here are cheap.
async function credentials() {
  return await import("@workspace/wiki-engine/agent/pi-credentials")
}

async function writeDefaultSettings(settings: {
  provider: string
  model: string
  thinking: "high"
}): Promise<void> {
  const { writePiAgentSettings } =
    await import("@workspace/wiki-engine/agent/pi")
  await writePiAgentSettings(settings)
}

export interface PiCredentialServiceOptions {
  status?: () => Promise<PiConnectionStatus>
  listApiKeyProviders?: () => Promise<PiProviderSummary[]>
  listModelsForProvider?: (provider: string) => Promise<PiModelSummary[]>
  isKnownProvider?: (provider: string) => Promise<boolean>
  saveApiKeyCredential?: (provider: string, apiKey: string) => Promise<void>
  writeDefaultModel?: (settings: {
    provider: string
    model: string
    thinking: "high"
  }) => Promise<void>
  startOAuthLogin?: (
    provider: PiOAuthProviderId,
    callbacks: OAuthLoginCallbacks
  ) => Promise<void>
  openExternal?: (url: string) => Promise<void>
}

interface PendingPrompt {
  promptId: string
  resolve: (value: string) => void
  reject: (error: unknown) => void
}

interface PendingLogin {
  abortController: AbortController
  pendingPrompt?: PendingPrompt
}

export class PiCredentialService {
  private readonly options: Required<PiCredentialServiceOptions>
  private readonly pendingLogins = new Map<string, PendingLogin>()
  private readonly listeners = new Set<(event: PiLoginEvent) => void>()

  constructor(options: PiCredentialServiceOptions = {}) {
    this.options = {
      status:
        options.status ??
        (async () => (await credentials()).readPiConnectionStatus()),
      listApiKeyProviders:
        options.listApiKeyProviders ??
        (async () => (await credentials()).listApiKeyProviders()),
      listModelsForProvider:
        options.listModelsForProvider ??
        (async (provider) =>
          (await credentials()).listModelsForProvider(provider)),
      isKnownProvider:
        options.isKnownProvider ??
        (async (provider) => (await credentials()).isKnownProvider(provider)),
      saveApiKeyCredential:
        options.saveApiKeyCredential ??
        (async (provider, apiKey) =>
          (await credentials()).saveApiKeyCredential(provider, apiKey)),
      writeDefaultModel: options.writeDefaultModel ?? writeDefaultSettings,
      startOAuthLogin:
        options.startOAuthLogin ??
        (async (provider, callbacks) =>
          (await credentials()).startPiOAuthLogin(provider, callbacks)),
      openExternal:
        options.openExternal ??
        (async (url) => {
          await shell.openExternal(url)
        }),
    }
  }

  subscribeLoginEvents(listener: (event: PiLoginEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async status(): Promise<PiConnectionStatus> {
    return await this.options.status()
  }

  async listApiKeyProviders(): Promise<PiProviderSummary[]> {
    return await this.options.listApiKeyProviders()
  }

  async listModels(provider: string): Promise<PiModelSummary[]> {
    await this.requireKnownProvider(provider)
    return await this.options.listModelsForProvider(provider)
  }

  async saveApiKeyCredential(provider: string, apiKey: string): Promise<void> {
    await this.requireKnownProvider(provider)
    await this.options.saveApiKeyCredential(provider, apiKey)
  }

  async setDefaultModel(provider: string, model: string): Promise<void> {
    await this.requireKnownProvider(provider)
    const models = await this.options.listModelsForProvider(provider)
    if (!models.some((candidate) => candidate.id === model)) {
      throw new WorkspaceServiceError(
        "invalid-input",
        "Choose a model offered by this provider."
      )
    }
    await this.options.writeDefaultModel({ provider, model, thinking: "high" })
  }

  startOAuthLogin(provider: PiOAuthProviderId): { loginId: string } {
    const loginId = randomUUID()
    const abortController = new AbortController()
    this.pendingLogins.set(loginId, { abortController })
    void this.runLogin(loginId, provider, abortController.signal)
    return { loginId }
  }

  respondToPrompt(loginId: string, promptId: string, value: string): void {
    const pending = this.pendingLogins.get(loginId)
    if (
      !pending?.pendingPrompt ||
      pending.pendingPrompt.promptId !== promptId
    ) {
      throw new WorkspaceServiceError(
        "invalid-input",
        "This prompt is no longer active."
      )
    }
    const { resolve } = pending.pendingPrompt
    pending.pendingPrompt = undefined
    resolve(value)
  }

  cancelLogin(loginId: string): void {
    const pending = this.pendingLogins.get(loginId)
    if (!pending) return
    pending.pendingPrompt?.reject(abortError())
    pending.pendingPrompt = undefined
    pending.abortController.abort()
  }

  dispose(): void {
    for (const pending of this.pendingLogins.values()) {
      pending.pendingPrompt?.reject(abortError())
      pending.abortController.abort()
    }
    this.pendingLogins.clear()
    this.listeners.clear()
  }

  private async requireKnownProvider(provider: string): Promise<void> {
    if (!(await this.options.isKnownProvider(provider))) {
      throw new WorkspaceServiceError(
        "invalid-input",
        "Choose a supported model provider."
      )
    }
  }

  private async runLogin(
    loginId: string,
    provider: PiOAuthProviderId,
    signal: AbortSignal
  ): Promise<void> {
    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => {
        this.emit({
          loginId,
          type: "auth",
          url: info.url,
          instructions: info.instructions,
        })
        void this.options.openExternal(info.url).catch(() => undefined)
      },
      onProgress: (message) => {
        this.emit({ loginId, type: "progress", message })
      },
      onDeviceCode: () => {
        // Amend only auto-selects the browser login method; the device-code
        // path is never chosen, so this should not be reachable in practice.
      },
      onPrompt: (prompt) => this.awaitPrompt(loginId, prompt),
      onSelect: async (prompt) => prompt.options[0]?.id,
      signal,
    }
    try {
      await this.options.startOAuthLogin(provider, callbacks)
      this.emit({ loginId, type: "completed" })
    } catch (error) {
      if (signal.aborted) {
        this.emit({ loginId, type: "cancelled" })
      } else {
        this.emit({
          loginId,
          type: "failed",
          error: {
            code: "pi-failed",
            message: loginFailureMessage(error),
          },
        })
      }
    } finally {
      this.pendingLogins.delete(loginId)
    }
  }

  private awaitPrompt(
    loginId: string,
    prompt: { message: string; placeholder?: string }
  ): Promise<string> {
    const promptId = randomUUID()
    return new Promise<string>((resolve, reject) => {
      const pending = this.pendingLogins.get(loginId)
      if (!pending) {
        reject(new Error("This login session is no longer active."))
        return
      }
      pending.pendingPrompt = { promptId, resolve, reject }
      this.emit({
        loginId,
        type: "prompt",
        promptId,
        message: prompt.message,
        placeholder: prompt.placeholder,
      })
    })
  }

  private emit(event: PiLoginEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Renderer delivery must not affect the login in progress.
      }
    }
  }
}

function abortError(): Error {
  const error = new Error("The login was cancelled.")
  error.name = "AbortError"
  return error
}

function loginFailureMessage(error: unknown): string {
  const fallback = "Could not connect this provider."
  if (!(error instanceof Error) || !error.message.trim()) return fallback
  return `${fallback} (${error.message.trim().slice(0, 300)})`
}
