import { useEffect, useReducer } from "react"
import type {
  AmendApi,
  PiLoginEvent,
  PiModelSummary,
  PiOAuthProviderId,
  PiProviderSummary,
} from "@workspace/contract"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Separator } from "@workspace/ui/components/separator"
import { Spinner } from "@workspace/ui/components/spinner"

import { errorMessage } from "@/lib/amend-client"

import { WorkflowError } from "./wiki-workflow-ui"

const oauthProviders: Array<{
  id: PiOAuthProviderId
  name: string
}> = [
  { id: "anthropic", name: "Anthropic (Claude Pro/Max)" },
  { id: "openai-codex", name: "ChatGPT Plus/Pro (Codex)" },
]

type Phase = "choose" | "login" | "api-key" | "model"

interface ConnectState {
  phase: Phase
  busy: boolean
  error?: string
  provider?: string
  loginId?: string
  authUrl?: string
  authInstructions?: string
  statusMessage?: string
  prompt?: { promptId: string; message: string; placeholder?: string }
  promptValue: string
  apiKeyProviders?: readonly PiProviderSummary[]
  apiKeyProvider?: string
  apiKeyValue: string
  models?: readonly PiModelSummary[]
  selectedModel?: string
}

type ConnectAction =
  | { type: "oauth-started"; provider: string; loginId: string }
  | { type: "login-event"; event: PiLoginEvent }
  | { type: "switch-to-api-key"; providers: readonly PiProviderSummary[] }
  | { type: "api-key-provider-changed"; provider: string }
  | { type: "api-key-value-changed"; value: string }
  | {
      type: "api-key-saved"
      provider: string
      models: readonly PiModelSummary[]
    }
  | { type: "models-loaded"; models: readonly PiModelSummary[] }
  | { type: "prompt-value-changed"; value: string }
  | { type: "prompt-submitted" }
  | { type: "model-selected"; model: string }
  | { type: "busy-started" }
  | { type: "busy-finished" }
  | { type: "error"; message: string }
  | { type: "back-to-choose" }

const initialState: ConnectState = {
  phase: "choose",
  busy: false,
  promptValue: "",
  apiKeyValue: "",
}

export function PiConnectStep({
  api,
  onConnected,
}: {
  api: AmendApi
  onConnected: () => void
}) {
  const [state, dispatch] = useReducer(connectReducer, initialState)

  useEffect(() => {
    return api.providers.onOAuthEvent((event) => {
      dispatch({ type: "login-event", event })
    })
  }, [api])

  useEffect(() => {
    const provider = state.provider
    if (state.phase !== "model" || !provider || state.models !== undefined) {
      return
    }

    let active = true
    void api.providers
      .listModels({ provider })
      .then((response) => {
        if (!active) return
        if (!response.ok) {
          dispatch({ type: "error", message: response.error.message })
          return
        }
        dispatch({ type: "models-loaded", models: response.value })
      })
      .catch((cause: unknown) => {
        if (active) dispatch({ type: "error", message: errorMessage(cause) })
      })

    return () => {
      active = false
    }
  }, [api, state.models, state.phase, state.provider])

  async function startOAuth(provider: PiOAuthProviderId) {
    dispatch({ type: "busy-started" })
    try {
      const response = await api.providers.startOAuth({ provider })
      if (!response.ok) {
        dispatch({ type: "error", message: response.error.message })
        return
      }
      dispatch({
        type: "oauth-started",
        provider,
        loginId: response.value.loginId,
      })
    } catch (cause) {
      dispatch({ type: "error", message: errorMessage(cause) })
    }
  }

  async function cancelOAuth() {
    if (!state.loginId) return
    try {
      await api.providers.cancelOAuth({ loginId: state.loginId })
    } catch {
      // The login may have already finished; nothing to reconcile here.
    }
  }

  async function submitPrompt() {
    if (!state.loginId || !state.prompt) return
    dispatch({ type: "busy-started" })
    try {
      const response = await api.providers.respondToOAuthPrompt({
        loginId: state.loginId,
        promptId: state.prompt.promptId,
        value: state.promptValue,
      })
      if (!response.ok) {
        dispatch({ type: "error", message: response.error.message })
        return
      }
      dispatch({ type: "prompt-submitted" })
    } catch (cause) {
      dispatch({ type: "error", message: errorMessage(cause) })
    }
  }

  async function switchToApiKey() {
    dispatch({ type: "busy-started" })
    try {
      const response = await api.providers.list()
      if (!response.ok) {
        dispatch({ type: "error", message: response.error.message })
        return
      }
      dispatch({ type: "switch-to-api-key", providers: response.value })
    } catch (cause) {
      dispatch({ type: "error", message: errorMessage(cause) })
    }
  }

  async function saveApiKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!state.apiKeyProvider || !state.apiKeyValue.trim()) return
    dispatch({ type: "busy-started" })
    try {
      const saveResponse = await api.providers.connectWithApiKey({
        provider: state.apiKeyProvider,
        apiKey: state.apiKeyValue.trim(),
      })
      if (!saveResponse.ok) {
        dispatch({ type: "error", message: saveResponse.error.message })
        return
      }
      const modelsResponse = await api.providers.listModels({
        provider: state.apiKeyProvider,
      })
      if (!modelsResponse.ok) {
        dispatch({ type: "error", message: modelsResponse.error.message })
        return
      }
      dispatch({
        type: "api-key-saved",
        provider: state.apiKeyProvider,
        models: modelsResponse.value,
      })
    } catch (cause) {
      dispatch({ type: "error", message: errorMessage(cause) })
    }
  }

  async function confirmDefaultModel() {
    if (!state.provider || !state.selectedModel) return
    dispatch({ type: "busy-started" })
    try {
      const response = await api.providers.setDefaultModel({
        provider: state.provider,
        model: state.selectedModel,
      })
      if (!response.ok) {
        dispatch({ type: "error", message: response.error.message })
        return
      }
      onConnected()
    } catch (cause) {
      dispatch({ type: "error", message: errorMessage(cause) })
    }
  }

  return (
    <section className="py-2 sm:py-4" aria-labelledby="connect-title">
      <header className="max-w-xl">
        <h1
          id="connect-title"
          className="font-heading text-3xl font-medium tracking-tight"
        >
          Connect a model provider
        </h1>
        <p className="mt-2 text-sm/relaxed text-muted-foreground">
          Amend uses your own account to read and write the wiki. Connect a
          provider once, and it stays configured for every future ingest.
        </p>
      </header>

      <div className="mt-8 flex flex-col gap-6">
        {state.phase === "choose" ? (
          <ChooseProviderStep
            busy={state.busy}
            onStartOAuth={(provider) => void startOAuth(provider)}
            onSwitchToApiKey={() => void switchToApiKey()}
          />
        ) : null}

        {state.phase === "login" ? (
          <OAuthLoginStep
            state={state}
            onPromptChange={(value) =>
              dispatch({ type: "prompt-value-changed", value })
            }
            onSubmitPrompt={() => void submitPrompt()}
            onCancel={() => void cancelOAuth()}
          />
        ) : null}

        {state.phase === "api-key" ? (
          <ApiKeyStep
            state={state}
            onSubmit={saveApiKey}
            onProviderChange={(provider) =>
              dispatch({ type: "api-key-provider-changed", provider })
            }
            onApiKeyChange={(value) =>
              dispatch({ type: "api-key-value-changed", value })
            }
            onBack={() => dispatch({ type: "back-to-choose" })}
          />
        ) : null}

        {state.phase === "model" ? (
          <ModelStep
            state={state}
            onModelSelect={(model) => dispatch({ type: "model-selected", model })}
            onConfirm={() => void confirmDefaultModel()}
          />
        ) : null}

        <WorkflowError message={state.error} />
      </div>
    </section>
  )
}

function ChooseProviderStep({
  busy,
  onStartOAuth,
  onSwitchToApiKey,
}: {
  busy: boolean
  onStartOAuth: (provider: PiOAuthProviderId) => void
  onSwitchToApiKey: () => void
}) {
  return (
    <>
      <FieldGroup className="gap-3">
        {oauthProviders.map((provider) => (
          <Button
            key={provider.id}
            type="button"
            variant="outline"
            size="lg"
            disabled={busy}
            onClick={() => onStartOAuth(provider.id)}
            className="w-full justify-start"
          >
            Connect {provider.name}
          </Button>
        ))}
      </FieldGroup>
      <Separator />
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={onSwitchToApiKey}
        className="w-fit"
      >
        {busy ? <Spinner data-icon="inline-start" /> : null}
        Or connect with an API key
      </Button>
    </>
  )
}

function OAuthLoginStep({
  state,
  onPromptChange,
  onSubmitPrompt,
  onCancel,
}: {
  state: ConnectState
  onPromptChange: (value: string) => void
  onSubmitPrompt: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="flex flex-col gap-4 border-y py-5"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <Spinner className="mt-0.5" />
        <div>
          <p className="text-sm font-medium">
            {state.statusMessage ?? "Connecting to your provider"}
          </p>
          {state.authInstructions ? (
            <p className="mt-1 text-xs/relaxed text-muted-foreground">
              {state.authInstructions}
            </p>
          ) : null}
          {state.authUrl ? (
            <p className="mt-1 text-xs/relaxed text-muted-foreground">
              If a browser window didn't open,{" "}
              <a href={state.authUrl} className="underline underline-offset-4">
                open this link
              </a>{" "}
              to finish connecting.
            </p>
          ) : null}
        </div>
      </div>

      {state.prompt ? (
        <Field>
          <FieldLabel htmlFor="pi-login-prompt">
            {state.prompt.message}
          </FieldLabel>
          <Input
            id="pi-login-prompt"
            value={state.promptValue}
            placeholder={state.prompt.placeholder}
            onChange={(event) => onPromptChange(event.target.value)}
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={state.busy || !state.promptValue.trim()}
              onClick={onSubmitPrompt}
            >
              Submit
            </Button>
          </div>
        </Field>
      ) : null}

      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function ApiKeyStep({
  state,
  onSubmit,
  onProviderChange,
  onApiKeyChange,
  onBack,
}: {
  state: ConnectState
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  onProviderChange: (provider: string) => void
  onApiKeyChange: (value: string) => void
  onBack: () => void
}) {
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <Field>
        <FieldLabel htmlFor="pi-api-key-provider">Provider</FieldLabel>
        <select
          id="pi-api-key-provider"
          aria-label="Provider"
          className="h-7 w-full rounded-md border border-input bg-input/20 px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          value={state.apiKeyProvider ?? ""}
          onChange={(event) => onProviderChange(event.target.value)}
          required
        >
          <option value="" disabled>
            Choose a provider
          </option>
          {state.apiKeyProviders?.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>
      </Field>

      <Field>
        <FieldLabel htmlFor="pi-api-key-value">API key</FieldLabel>
        <Input
          id="pi-api-key-value"
          type="password"
          value={state.apiKeyValue}
          onChange={(event) => onApiKeyChange(event.target.value)}
          required
        />
        <FieldDescription>
          Stored locally and used only to reach this provider's API.
        </FieldDescription>
      </Field>

      <div className="flex justify-between">
        <Button type="button" variant="ghost" disabled={state.busy} onClick={onBack}>
          Back
        </Button>
        <Button
          type="submit"
          disabled={
            state.busy || !state.apiKeyProvider || !state.apiKeyValue.trim()
          }
        >
          {state.busy ? <Spinner data-icon="inline-start" /> : null}
          Save and continue
        </Button>
      </div>
    </form>
  )
}

function ModelStep({
  state,
  onModelSelect,
  onConfirm,
}: {
  state: ConnectState
  onModelSelect: (model: string) => void
  onConfirm: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="pi-default-model">Default model</FieldLabel>
        <select
          id="pi-default-model"
          aria-label="Default model"
          className="h-7 w-full rounded-md border border-input bg-input/20 px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          value={state.selectedModel ?? ""}
          disabled={state.busy}
          onChange={(event) => onModelSelect(event.target.value)}
          required
        >
          <option value="" disabled>
            Choose a model
          </option>
          {state.models?.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
        <FieldDescription>
          Used to read documents and write the wiki. You can change this later.
        </FieldDescription>
      </Field>

      <div className="flex justify-end border-t pt-4">
        <Button
          type="button"
          size="lg"
          disabled={state.busy || !state.selectedModel}
          onClick={onConfirm}
        >
          {state.busy ? <Spinner data-icon="inline-start" /> : null}
          Continue
        </Button>
      </div>
    </div>
  )
}

function connectReducer(
  state: ConnectState,
  action: ConnectAction
): ConnectState {
  switch (action.type) {
    case "oauth-started":
      return {
        ...state,
        phase: "login",
        busy: false,
        error: undefined,
        provider: action.provider,
        loginId: action.loginId,
        authUrl: undefined,
        authInstructions: undefined,
        statusMessage: undefined,
        prompt: undefined,
        promptValue: "",
      }
    case "login-event": {
      if (action.event.loginId !== state.loginId) return state
      const event = action.event
      switch (event.type) {
        case "auth":
          return {
            ...state,
            authUrl: event.url,
            authInstructions: event.instructions,
            statusMessage: "Waiting for you to finish in your browser",
          }
        case "progress":
          return { ...state, statusMessage: event.message }
        case "prompt":
          return {
            ...state,
            busy: false,
            prompt: {
              promptId: event.promptId,
              message: event.message,
              placeholder: event.placeholder,
            },
            promptValue: "",
          }
        case "completed":
          return {
            ...state,
            phase: "model",
            busy: true,
            prompt: undefined,
            models: undefined,
            selectedModel: undefined,
          }
        case "cancelled":
          return {
            ...state,
            phase: "choose",
            busy: false,
            loginId: undefined,
            prompt: undefined,
          }
        case "failed":
          return {
            ...state,
            phase: "choose",
            busy: false,
            loginId: undefined,
            prompt: undefined,
            error: event.error.message,
          }
      }
      return state
    }
    case "switch-to-api-key":
      return {
        ...state,
        phase: "api-key",
        busy: false,
        error: undefined,
        apiKeyProviders: action.providers,
      }
    case "api-key-provider-changed":
      return { ...state, apiKeyProvider: action.provider }
    case "api-key-value-changed":
      return { ...state, apiKeyValue: action.value }
    case "api-key-saved":
      return {
        ...state,
        phase: "model",
        busy: false,
        provider: action.provider,
        models: action.models,
        selectedModel: undefined,
      }
    case "models-loaded":
      return {
        ...state,
        busy: false,
        models: action.models,
      }
    case "prompt-value-changed":
      return { ...state, promptValue: action.value }
    case "prompt-submitted":
      return {
        ...state,
        busy: false,
        prompt: undefined,
        promptValue: "",
        statusMessage: "Finishing up",
      }
    case "model-selected":
      return { ...state, selectedModel: action.model }
    case "busy-started":
      return { ...state, busy: true, error: undefined }
    case "busy-finished":
      return { ...state, busy: false }
    case "error":
      return { ...state, busy: false, error: action.message }
    case "back-to-choose":
      return { ...initialState }
  }
}
