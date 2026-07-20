import { join } from "node:path"

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent"
import {
  getOAuthProvider,
  OPENAI_CODEX_BROWSER_LOGIN_METHOD,
} from "@earendil-works/pi-ai/oauth"
import type {
  OAuthAuthInfo,
  OAuthDeviceCodeInfo,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthSelectPrompt,
} from "@earendil-works/pi-ai/oauth"

import { getAgentDirectory, readPiAgentSettings } from "./pi.ts"

/**
 * OAuth providers Amend offers a dedicated connect button for. Every other
 * provider known to the model registry is reachable through the generic
 * API-key form instead.
 */
export const piOAuthProviderIds = ["anthropic", "openai-codex"] as const
export type PiOAuthProviderId = (typeof piOAuthProviderIds)[number]

export function isPiOAuthProviderId(
  value: unknown
): value is PiOAuthProviderId {
  return (
    typeof value === "string" &&
    (piOAuthProviderIds as readonly string[]).includes(value)
  )
}

export interface PiProviderSummary {
  id: string
  name: string
}

export interface PiModelSummary {
  id: string
  name: string
}

export interface PiConnectionStatus {
  configured: boolean
  provider?: string
  model?: string
}

export type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth"

function createAuthStorage(): AuthStorage {
  return AuthStorage.create(join(getAgentDirectory(), "auth.json"))
}

function createModelRegistry(authStorage: AuthStorage): ModelRegistry {
  return ModelRegistry.create(
    authStorage,
    join(getAgentDirectory(), "models.json")
  )
}

/**
 * Whether Amend has a usable default Pi provider/model with real
 * credentials configured. Used to decide whether to show the connect flow.
 */
export async function readPiConnectionStatus(): Promise<PiConnectionStatus> {
  let settings
  try {
    settings = await readPiAgentSettings()
  } catch {
    return { configured: false }
  }
  const authStorage = createAuthStorage()
  const configured = authStorage.hasAuth(settings.provider)
  return {
    configured,
    provider: settings.provider,
    model: settings.model,
  }
}

/**
 * Providers usable through the generic API-key form, i.e. every provider
 * known to the model registry except the ones with a dedicated OAuth flow.
 */
export function listApiKeyProviders(): PiProviderSummary[] {
  const authStorage = createAuthStorage()
  const registry = createModelRegistry(authStorage)
  const providers = new Map<string, string>()
  for (const model of registry.getAll()) {
    if (isPiOAuthProviderId(model.provider)) continue
    if (!providers.has(model.provider)) {
      providers.set(
        model.provider,
        registry.getProviderDisplayName(model.provider)
      )
    }
  }
  return [...providers.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function listModelsForProvider(provider: string): PiModelSummary[] {
  const authStorage = createAuthStorage()
  const registry = createModelRegistry(authStorage)
  return registry
    .getAll()
    .filter((model) => model.provider === provider)
    .map((model) => ({ id: model.id, name: model.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function isKnownProvider(provider: string): boolean {
  const authStorage = createAuthStorage()
  const registry = createModelRegistry(authStorage)
  return registry.getAll().some((model) => model.provider === provider)
}

export function saveApiKeyCredential(provider: string, apiKey: string): void {
  const authStorage = createAuthStorage()
  authStorage.set(provider, { type: "api_key", key: apiKey })
}

/**
 * Drive an OAuth login for one of the built-in providers Amend supports.
 * Persists the resulting credentials to auth.json on success (handled by
 * AuthStorage.login itself).
 */
export async function startPiOAuthLogin(
  provider: PiOAuthProviderId,
  callbacks: OAuthLoginCallbacks
): Promise<void> {
  const authStorage = createAuthStorage()
  await authStorage.login(provider, {
    ...callbacks,
    // Amend only offers a browser-based experience; auto-answer the
    // provider's internal browser-vs-device-code choice instead of
    // surfacing it as another prompt.
    onSelect: async (prompt: OAuthSelectPrompt) =>
      prompt.options.find(
        (option) => option.id === OPENAI_CODEX_BROWSER_LOGIN_METHOD
      )?.id ?? prompt.options[0]?.id,
  })
}

export function piAgentDirectory(): string {
  return getAgentDirectory()
}

export type {
  OAuthAuthInfo as PiOAuthAuthInfo,
  OAuthDeviceCodeInfo as PiOAuthDeviceCodeInfo,
  OAuthPrompt as PiOAuthPrompt,
}

export function isOAuthProviderRegistered(provider: string): boolean {
  return getOAuthProvider(provider) !== undefined
}
