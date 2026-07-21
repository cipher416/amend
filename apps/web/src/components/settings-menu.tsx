import { ArrowLeft01Icon, Settings02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import type {
  AmendApi,
  PiConnectionStatus,
  PiModelSummary,
} from "@workspace/contract"
import { themeSources } from "@workspace/contract"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Separator } from "@workspace/ui/components/separator"
import { SidebarMenuButton } from "@workspace/ui/components/sidebar"
import { Spinner } from "@workspace/ui/components/spinner"
import { useEffect, useState } from "react"
import type { ReactNode } from "react"

import { errorMessage } from "@/lib/amend-client"

import { ModelPicker, PiConnectStep } from "./pi-connect-step"
import { useTheme } from "./theme"

type SettingsView = "overview" | "model" | "connection"

export function SettingsMenu({ desktop }: { desktop: AmendApi }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<SettingsView>("overview")
  const [status, setStatus] = useState<PiConnectionStatus>()
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open || view === "connection") return

    let active = true
    setLoadingStatus(true)
    setError(undefined)
    void desktop.providers
      .status()
      .then((response) => {
        if (!active) return
        if (!response.ok) {
          setError(response.error.message)
          return
        }
        setStatus(response.value)
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause))
      })
      .finally(() => {
        if (active) setLoadingStatus(false)
      })

    return () => {
      active = false
    }
  }, [desktop, open, view])

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) {
      setView("overview")
      setError(undefined)
    }
  }

  function handleConnectionUpdated() {
    setView("overview")
  }

  return (
    <>
      <SidebarMenuButton
        aria-label="Settings"
        className="w-auto"
        type="button"
        onClick={() => setOpen(true)}
      >
        <HugeiconsIcon icon={Settings02Icon} />
      </SidebarMenuButton>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex max-h-[calc(100svh-2rem)] max-w-md flex-col gap-0 p-0 sm:max-w-md">
          {view === "connection" ? (
            <ConnectionSettings
              desktop={desktop}
              onBack={() => setView("overview")}
              onConnected={handleConnectionUpdated}
            />
          ) : view === "model" && status?.provider ? (
            <ModelSettings
              desktop={desktop}
              provider={status.provider}
              currentModel={status.model}
              onBack={() => setView("overview")}
              onSaved={(model) => {
                setStatus((current) =>
                  current ? { ...current, model } : current
                )
                setView("overview")
              }}
            />
          ) : (
            <SettingsOverview
              status={status}
              loading={loadingStatus}
              error={error}
              onManageModel={() => setView("model")}
              onManageConnection={() => setView("connection")}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function SettingsOverview({
  status,
  loading,
  error,
  onManageModel,
  onManageConnection,
}: {
  status?: PiConnectionStatus
  loading: boolean
  error?: string
  onManageModel: () => void
  onManageConnection: () => void
}) {
  const { theme, setTheme } = useTheme()

  return (
    <>
      <DialogHeader className="px-6 pt-6">
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>
          Manage how Amend connects to and uses AI.
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 scroll-fade flex-col gap-6 overflow-y-auto px-6 pb-6">
        <SettingsSection
          title="AI connection"
          description={
            status?.configured
              ? `Connected to ${status.provider}.`
              : "Connect an AI account or API key."
          }
        >
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={onManageConnection}
          >
            {loading ? <Spinner data-icon="inline-start" /> : null}
            {status?.configured ? "Change connection" : "Connect provider"}
          </Button>
        </SettingsSection>
        <Separator />
        <SettingsSection
          title="Default model"
          description={
            status?.configured
              ? (status.model ?? "No default model selected.")
              : "Choose a provider before selecting a model."
          }
        >
          <Button
            type="button"
            variant="outline"
            disabled={loading || !status?.configured}
            onClick={onManageModel}
          >
            Manage model
          </Button>
        </SettingsSection>
        <Separator />
        <SettingsSection
          title="Appearance"
          description="Choose how Amend looks."
        >
          <div className="flex gap-2" role="radiogroup" aria-label="Theme">
            {themeSources.map((option) => (
              <Button
                key={option}
                type="button"
                variant={theme === option ? "secondary" : "outline"}
                size="sm"
                role="radio"
                aria-checked={theme === option}
                onClick={() => setTheme(option)}
                className="capitalize"
              >
                {option}
              </Button>
            ))}
          </div>
        </SettingsSection>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </>
  )
}

function ConnectionSettings({
  desktop,
  onBack,
  onConnected,
}: {
  desktop: AmendApi
  onBack: () => void
  onConnected: () => void
}) {
  return (
    <div className="min-h-0 flex-1 scroll-fade overflow-y-auto px-6 pt-6 pb-6">
      <DialogTitle className="sr-only">AI connection</DialogTitle>
      <DialogDescription className="sr-only">
        Connect or change the AI provider Amend uses.
      </DialogDescription>
      <Button type="button" variant="ghost" size="sm" onClick={onBack}>
        <HugeiconsIcon icon={ArrowLeft01Icon} data-icon="inline-start" />
        Back to settings
      </Button>
      <PiConnectStep api={desktop} onConnected={onConnected} />
    </div>
  )
}

function ModelSettings({
  desktop,
  provider,
  currentModel,
  onBack,
  onSaved,
}: {
  desktop: AmendApi
  provider: string
  currentModel?: string
  onBack: () => void
  onSaved: (model: string) => void
}) {
  const [models, setModels] = useState<readonly PiModelSummary[]>()
  const [selectedModel, setSelectedModel] = useState(currentModel)
  const [loadingModels, setLoadingModels] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    void desktop.providers
      .listModels({ provider })
      .then((response) => {
        if (!active) return
        if (!response.ok) {
          setError(response.error.message)
          return
        }
        setModels(response.value)
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause))
      })
      .finally(() => {
        if (active) setLoadingModels(false)
      })

    return () => {
      active = false
    }
  }, [desktop, provider])

  async function saveModel() {
    if (!selectedModel) return
    setBusy(true)
    setError(undefined)
    try {
      const response = await desktop.providers.setDefaultModel({
        provider,
        model: selectedModel,
      })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      onSaved(selectedModel)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader className="px-6 pt-6">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="-ml-2 w-fit"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} data-icon="inline-start" />
          Back to settings
        </Button>
        <DialogTitle>Default model</DialogTitle>
        <DialogDescription>
          Select the model Amend uses to read documents and write your wiki.
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-5 px-6 pb-6">
        {models ? (
          <ModelPicker
            models={models}
            value={selectedModel}
            disabled={busy}
            onChange={setSelectedModel}
          />
        ) : loadingModels ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Loading models
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Models could not be loaded for this provider.
          </p>
        )}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="mt-auto flex justify-end border-t pt-4">
          <Button
            type="button"
            disabled={busy || !selectedModel || !models}
            onClick={() => void saveModel()}
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Save model
          </Button>
        </div>
      </div>
    </>
  )
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="font-medium text-foreground">{title}</h2>
        <p className="mt-1 text-xs/relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      {children}
    </section>
  )
}
