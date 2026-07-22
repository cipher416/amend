import { useEffect, useReducer } from "react"
import { useQuery } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import type { ReactNode } from "react"
import type {
  AmendApi,
  IngestPastedSourceResult,
  SourceDocumentSelection,
  WikiIngestChangedEvent,
  WikiIngestJob,
  WikiHome,
  WikiSummary,
} from "@workspace/contract"
import { Spinner } from "@workspace/ui/components/spinner"

import { errorMessage, useAmendApi } from "@/lib/amend-client"
import { projectWikiIngestChanged } from "@/lib/wiki-ingest-events"
import {
  chooseWikiHome,
  providerStatusKey,
  readCurrentIngest,
  readCurrentWiki,
  readWikiHome,
  readProviderStatus,
  wikiCurrentKey,
  wikiHomeKey,
  wikiIngestKey,
  wikisKey,
} from "@/lib/wiki-queries"

import { PiConnectStep } from "./pi-connect-step"
import { WikiReadyStep } from "./wiki-ready-step"
import { WikiSetupStep } from "./wiki-setup-step"
import { WorkflowShell } from "./wiki-workflow-ui"

type BusyOperation =
  "home" | "switch" | "document" | "create" | "ingest" | "index" | null

interface WorkflowState {
  piConfigured?: boolean
  busy: BusyOperation
  error?: string
  home?: WikiHome
  wiki?: WikiSummary
  document?: SourceDocumentSelection
  sourceFiles?: File[]
  job?: WikiIngestJob
  wikiName: string
  wikiNameEdited: boolean
  focus: string
}

type EditableField = "wikiName" | "focus"

interface WorkflowStepViewProps {
  api: AmendApi
  state: WorkflowState
  piConfigured: boolean
  wiki?: WikiSummary
  home?: WikiHome
  job?: WikiIngestJob
  error?: string
  onProviderConnected: () => void
  onRetryIndex: () => void
  onFieldChange: (field: EditableField, value: string) => void
  onChooseHome: () => void
  onRegisterDocument: (file: File) => void
  onDocumentError: (message: string) => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}

interface WorkflowActions {
  chooseHome: () => Promise<void>
  registerDocument: (file: File) => Promise<void>
  createWiki: (event: React.FormEvent<HTMLFormElement>) => Promise<void>
  retryIndex: () => Promise<void>
  changeField: (field: EditableField, value: string) => void
}

interface WorkflowActionsInput {
  api: AmendApi
  state: WorkflowState
  wiki?: WikiSummary
  home?: WikiHome
  queryClient: QueryClient
  dispatch: React.Dispatch<WorkflowAction>
}

type WorkflowAction =
  | { type: "pi-connected" }
  | { type: "field-changed"; field: EditableField; value: string }
  | { type: "operation-started"; operation: Exclude<BusyOperation, null> }
  | { type: "operation-finished" }
  | { type: "operation-failed"; message: string }
  | { type: "home-selected"; home: WikiHome }
  | {
      type: "document-selected"
      document: SourceDocumentSelection
      sourceFiles: File[]
    }
  | { type: "wiki-created"; wiki: WikiSummary }
  | { type: "ingest-started" }
  | { type: "ingest-changed"; event: WikiIngestChangedEvent }
  | { type: "index-refreshed"; index: IngestPastedSourceResult["index"] }

const initialWorkflowState: WorkflowState = {
  busy: null,
  wikiName: "",
  wikiNameEdited: false,
  focus: "",
}

export function WikiWorkflow({
  readyElement,
  createWiki = false,
}: {
  readyElement?: ReactNode
  createWiki?: boolean
}) {
  const queryClient = useRouter().options.context.queryClient
  const [state, dispatch] = useReducer(workflowReducer, initialWorkflowState)
  const desktop = useAmendApi()

  const providerStatus = useQuery(
    {
      queryKey: providerStatusKey,
      queryFn: () => readProviderStatus(requireDesktop(desktop)),
      enabled: Boolean(desktop),
    },
    queryClient
  )
  const currentWiki = useQuery(
    {
      queryKey: wikiCurrentKey,
      queryFn: () => readCurrentWiki(requireDesktop(desktop)),
      enabled: Boolean(desktop),
    },
    queryClient
  )
  const wikiHome = useQuery(
    {
      queryKey: wikiHomeKey,
      queryFn: () => readWikiHome(requireDesktop(desktop)),
      enabled: Boolean(desktop),
    },
    queryClient
  )
  const currentWikiId = createWiki ? undefined : currentWiki.data?.id
  const currentIngest = useQuery(
    {
      queryKey: currentWikiId
        ? wikiIngestKey(currentWikiId)
        : ["wiki", "ingest", "disabled"],
      queryFn: () => readCurrentIngest(requireDesktop(desktop)),
      enabled: Boolean(desktop && currentWikiId),
    },
    queryClient
  )

  const queriedWiki = createWiki ? undefined : (currentWiki.data ?? undefined)
  const queriedJob = currentIngest.data ?? undefined
  const wiki = state.wiki ?? queriedWiki
  const home = state.home ?? wikiHome.data ?? undefined
  const job =
    queriedJob && !isOlderJob(queriedJob, state.job) ? queriedJob : state.job
  const piConfigured =
    state.piConfigured ?? providerStatus.data?.configured ?? false
  const activeWikiId = wiki?.id

  useEffect(() => {
    if (!desktop) return
    const unsubscribe = desktop.wiki.onIngestChanged((event) => {
      projectWikiIngestChanged(queryClient, event)
      if (event.wikiId === activeWikiId) {
        dispatch({ type: "ingest-changed", event })
      }
    })
    return unsubscribe
  }, [activeWikiId, desktop, queryClient])

  const recovering = Boolean(
    desktop &&
    (providerStatus.isPending ||
      currentWiki.isPending ||
      wikiHome.isPending ||
      (Boolean(currentWikiId) && currentIngest.isPending))
  )
  if (desktop === undefined || recovering) {
    return <OpeningScreen />
  }
  if (desktop === null) return <DesktopRequired />
  if (
    (!createWiki || state.wiki !== undefined) &&
    piConfigured &&
    wiki?.setupStatus === "ready" &&
    readyElement
  ) {
    return readyElement
  }

  const api = desktop
  const sessionError =
    queryErrorMessage(providerStatus.error) ??
    queryErrorMessage(currentWiki.error) ??
    queryErrorMessage(wikiHome.error) ??
    queryErrorMessage(currentIngest.error)
  const error = state.error ?? sessionError
  const actions = useWikiWorkflowActions({
    api,
    state,
    wiki,
    home,
    queryClient,
    dispatch,
  })

  return (
    <WorkflowStepView
      api={api}
      state={state}
      piConfigured={piConfigured}
      wiki={wiki}
      job={job}
      error={error}
      onProviderConnected={() => {
        queryClient.setQueryData(providerStatusKey, { configured: true })
        dispatch({ type: "pi-connected" })
      }}
      onRetryIndex={() => void actions.retryIndex()}
      onFieldChange={actions.changeField}
      onChooseHome={() => void actions.chooseHome()}
      onRegisterDocument={(file) => void actions.registerDocument(file)}
      onDocumentError={(message) =>
        dispatch({ type: "operation-failed", message })
      }
      onSubmit={(event) => void actions.createWiki(event)}
      home={home}
    />
  )
}

function useWikiWorkflowActions({
  api,
  state,
  wiki,
  home,
  queryClient,
  dispatch,
}: WorkflowActionsInput): WorkflowActions {
  return {
    chooseHome: async () => {
      dispatch({ type: "operation-started", operation: "home" })
      try {
        const home = await chooseWikiHome(api)
        if (home) {
          queryClient.setQueryData(wikiHomeKey, home)
          dispatch({ type: "home-selected", home })
        } else {
          dispatch({ type: "operation-finished" })
        }
      } catch (cause) {
        dispatch({ type: "operation-failed", message: errorMessage(cause) })
      }
    },
    registerDocument: async (file) => {
      dispatch({ type: "operation-started", operation: "document" })
      try {
        const response = await api.wiki.registerDocument(file)
        if (!response.ok) {
          dispatch({
            type: "operation-failed",
            message: response.error.message,
          })
        } else {
          dispatch({
            type: "document-selected",
            document: response.value,
            sourceFiles: [file],
          })
        }
      } catch (cause) {
        dispatch({ type: "operation-failed", message: errorMessage(cause) })
      }
    },
    createWiki: async (event) => {
      event.preventDefault()
      if (!state.document) {
        dispatch({
          type: "operation-failed",
          message: "Choose the first source document.",
        })
        return
      }

      const wikiName = state.wikiName.trim()
      const focus = state.focus.trim()

      let targetWiki = wiki
      if (!targetWiki) {
        if (!home) {
          dispatch({
            type: "operation-failed",
            message: "Choose a wiki home before creating a wiki.",
          })
          return
        }
        dispatch({ type: "operation-started", operation: "create" })
        try {
          const response = await api.wikis.create({
            name: wikiName,
            domain: focus || wikiName,
          })
          if (!response.ok) {
            dispatch({
              type: "operation-failed",
              message: response.error.message,
            })
            return
          }
          targetWiki = response.value
          queryClient.setQueryData(wikiCurrentKey, targetWiki)
          void queryClient.invalidateQueries({ queryKey: wikisKey })
          dispatch({ type: "wiki-created", wiki: targetWiki })
        } catch (cause) {
          dispatch({ type: "operation-failed", message: errorMessage(cause) })
          return
        }
      }

      const domain = targetWiki.domain

      dispatch({ type: "operation-started", operation: "ingest" })
      try {
        const response = await api.wiki.startIngest({
          documentToken: state.document.token,
          objective:
            focus ||
            `Capture the central concepts, evidence, and important tradeoffs relevant to ${domain}.`,
        })
        if (!response.ok) {
          dispatch({
            type: "operation-failed",
            message: response.error.message,
          })
          return
        }
        dispatch({ type: "ingest-started" })
        const snapshot = await api.wiki.currentIngest()
        if (snapshot.ok && snapshot.value?.id === response.value.jobId) {
          queryClient.setQueryData(wikiIngestKey(targetWiki.id), snapshot.value)
          dispatch({
            type: "ingest-changed",
            event: { wikiId: targetWiki.id, job: snapshot.value },
          })
        }
      } catch (cause) {
        dispatch({ type: "operation-failed", message: errorMessage(cause) })
      }
    },
    retryIndex: async () => {
      dispatch({ type: "operation-started", operation: "index" })
      try {
        const response = await api.wiki.refreshIndex()
        if (!response.ok) {
          dispatch({
            type: "operation-failed",
            message: response.error.message,
          })
          return
        }
        dispatch({
          type: "index-refreshed",
          index: { status: "ready", summary: response.value },
        })
      } catch (cause) {
        dispatch({ type: "operation-failed", message: errorMessage(cause) })
      }
    },
    changeField: (field, value) => {
      dispatch({ type: "field-changed", field, value })
    },
  }
}

function WorkflowStepView({
  api,
  state,
  piConfigured,
  wiki,
  home,
  job,
  error,
  onProviderConnected,
  onRetryIndex,
  onFieldChange,
  onChooseHome,
  onRegisterDocument,
  onDocumentError,
  onSubmit,
}: WorkflowStepViewProps) {
  return (
    <WorkflowShell>
      {!piConfigured ? (
        <PiConnectStep api={api} onConnected={onProviderConnected} />
      ) : wiki?.setupStatus === "ready" &&
        (!job || (job.status === "completed" && job.result)) ? (
        <WikiReadyStep
          wiki={wiki}
          ingest={job?.result}
          refreshing={state.busy === "index"}
          error={error}
          onRetryIndex={onRetryIndex}
        />
      ) : (
        <WikiSetupStep
          wiki={wiki}
          wikiName={state.wikiName}
          home={home}
          document={state.document}
          sourceFiles={state.sourceFiles}
          focus={state.focus}
          job={job}
          busy={state.busy !== null}
          submitting={state.busy === "create" || state.busy === "ingest"}
          error={error}
          onFieldChange={onFieldChange}
          onChooseHome={onChooseHome}
          onRegisterDocument={onRegisterDocument}
          onDocumentError={onDocumentError}
          onSubmit={onSubmit}
        />
      )}
    </WorkflowShell>
  )
}

function requireDesktop(desktop: AmendApi | null | undefined): AmendApi {
  if (!desktop) throw new Error("Amend desktop API is unavailable")
  return desktop
}

function queryErrorMessage(error: Error | null): string | undefined {
  return error ? errorMessage(error) : undefined
}

function workflowReducer(
  state: WorkflowState,
  action: WorkflowAction
): WorkflowState {
  switch (action.type) {
    case "pi-connected":
      return { ...state, piConfigured: true }
    case "field-changed":
      return {
        ...state,
        [action.field]: action.value,
        wikiNameEdited:
          action.field === "wikiName" ? true : state.wikiNameEdited,
      }
    case "operation-started":
      return { ...state, busy: action.operation, error: undefined }
    case "operation-finished":
      return { ...state, busy: null }
    case "operation-failed":
      return { ...state, busy: null, error: action.message }
    case "home-selected":
      return { ...state, home: action.home, busy: null }
    case "document-selected":
      return {
        ...state,
        document: action.document,
        sourceFiles: action.sourceFiles,
        wikiName: state.wikiNameEdited
          ? state.wikiName
          : suggestedWikiName(action.document.suggestedTitle),
        job: undefined,
        busy: null,
        error: undefined,
      }
    case "wiki-created":
      return {
        ...state,
        wiki: action.wiki,
        job: undefined,
        document: undefined,
        sourceFiles: undefined,
        busy: null,
        error: undefined,
      }
    case "ingest-started":
      return {
        ...state,
        document: undefined,
        sourceFiles: undefined,
        busy: "ingest",
        error: undefined,
      }
    case "ingest-changed":
      return applyIngestEvent(state, action.event)
    case "index-refreshed":
      return {
        ...state,
        job:
          state.job?.result === undefined
            ? state.job
            : {
                ...state.job,
                result: { ...state.job.result, index: action.index },
              },
        busy: null,
      }
  }
}

function suggestedWikiName(title: string): string {
  const suggestion = title
    .trim()
    .replaceAll("/", "-")
    .replaceAll("\\", "-")
    .replaceAll("\0", "-")
    .slice(0, 80)
    .trim()
  return suggestion && suggestion !== "." && suggestion !== ".."
    ? suggestion
    : "Document"
}

function applyIngestEvent(
  state: WorkflowState,
  event: WikiIngestChangedEvent
): WorkflowState {
  if (isOlderJob(event.job, state.job)) return state
  return applyJob(state, event.job)
}

function applyJob(state: WorkflowState, job?: WikiIngestJob): WorkflowState {
  if (!job) return { ...state, job: undefined, busy: null }
  if (job.status === "running") {
    return { ...state, job, busy: "ingest", error: undefined }
  }
  const wiki =
    job.status === "completed" && job.result && state.wiki
      ? {
          ...state.wiki,
          commitHash: job.result.commitHash,
          setupStatus: "ready" as const,
        }
      : state.wiki
  return { ...state, wiki, job, busy: null, error: undefined }
}

function isOlderJob(next: WikiIngestJob, current?: WikiIngestJob): boolean {
  return current?.id === next.id && next.revision < current.revision
}

function OpeningScreen() {
  return (
    <main className="grid min-h-svh place-items-center bg-background text-foreground">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner />
        <span>Opening Amend</span>
      </div>
    </main>
  )
}

function DesktopRequired() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
      <section className="w-full max-w-sm" aria-labelledby="desktop-title">
        <h1
          id="desktop-title"
          className="font-heading text-3xl font-medium tracking-tight"
        >
          Your wiki lives on your machine.
        </h1>
        <p className="mt-2 text-sm/relaxed text-muted-foreground">
          Open this interface in the Amend desktop application to create a local
          wiki.
        </p>
      </section>
    </main>
  )
}
