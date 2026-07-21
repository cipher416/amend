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
  WorkspaceHome,
  WorkspaceListItem,
  WorkspaceSummary,
} from "@workspace/contract"
import { Spinner } from "@workspace/ui/components/spinner"

import { errorMessage, useAmendApi } from "@/lib/amend-client"
import { projectWorkspaceIngestChanged } from "@/lib/workspace-ingest-events"
import {
  chooseWorkspaceHome,
  listWorkspaces,
  providerStatusKey,
  readCurrentIngest,
  readCurrentWorkspace,
  readWorkspaceHome,
  readProviderStatus,
  workspaceCurrentKey,
  workspaceHomeKey,
  workspaceIngestKey,
  workspacesKey,
} from "@/lib/workspace-queries"

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
  home?: WorkspaceHome
  workspace?: WorkspaceSummary
  document?: SourceDocumentSelection
  sourceFiles?: File[]
  job?: WikiIngestJob
  wikiName: string
  domain: string
  objective: string
}

type EditableField = "wikiName" | "domain" | "objective"

interface WorkflowStepViewProps {
  api: AmendApi
  state: WorkflowState
  piConfigured: boolean
  workspace?: WorkspaceSummary
  home?: WorkspaceHome
  createWorkspace: boolean
  knownWorkspaces: readonly WorkspaceListItem[]
  job?: WikiIngestJob
  error?: string
  onActivateWorkspace: (workspaceId: string) => void
  onProviderConnected: () => void
  onRetryIndex: () => void
  onFieldChange: (field: EditableField, value: string) => void
  onChooseHome: () => void
  onRegisterDocument: (file: File) => void
  onDocumentError: (message: string) => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  onCancel: () => void
}

interface WorkflowActions {
  chooseHome: () => Promise<void>
  registerDocument: (file: File) => Promise<void>
  createWiki: (event: React.FormEvent<HTMLFormElement>) => Promise<void>
  activateWorkspace: (workspaceId: string) => Promise<void>
  cancelIngest: () => Promise<void>
  retryIndex: () => Promise<void>
  changeField: (field: EditableField, value: string) => void
}

interface WorkflowActionsInput {
  api: AmendApi
  state: WorkflowState
  workspace?: WorkspaceSummary
  home?: WorkspaceHome
  job?: WikiIngestJob
  queryClient: QueryClient
  dispatch: React.Dispatch<WorkflowAction>
}

type WorkflowAction =
  | { type: "pi-connected" }
  | { type: "field-changed"; field: EditableField; value: string }
  | { type: "operation-started"; operation: Exclude<BusyOperation, null> }
  | { type: "operation-finished" }
  | { type: "operation-failed"; message: string }
  | { type: "home-selected"; home: WorkspaceHome }
  | {
      type: "document-selected"
      document: SourceDocumentSelection
      sourceFiles: File[]
    }
  | { type: "workspace-created"; workspace: WorkspaceSummary }
  | {
      type: "workspace-activated"
      workspace: WorkspaceSummary
      job: WikiIngestJob | null
    }
  | { type: "ingest-started" }
  | { type: "ingest-changed"; event: WikiIngestChangedEvent }
  | { type: "index-refreshed"; index: IngestPastedSourceResult["index"] }

const initialWorkflowState: WorkflowState = {
  busy: null,
  wikiName: "",
  domain: "",
  objective: "",
}

export function WikiWorkflow({
  readyElement,
  createWorkspace = false,
}: {
  readyElement?: ReactNode
  createWorkspace?: boolean
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
  const currentWorkspace = useQuery(
    {
      queryKey: workspaceCurrentKey,
      queryFn: () => readCurrentWorkspace(requireDesktop(desktop)),
      enabled: Boolean(desktop),
    },
    queryClient
  )
  const workspaces = useQuery(
    {
      queryKey: workspacesKey,
      queryFn: () => listWorkspaces(requireDesktop(desktop)),
      enabled: Boolean(desktop),
    },
    queryClient
  )
  const workspaceHome = useQuery(
    {
      queryKey: workspaceHomeKey,
      queryFn: () => readWorkspaceHome(requireDesktop(desktop)),
      enabled: Boolean(desktop),
    },
    queryClient
  )
  const currentWorkspaceId = createWorkspace
    ? undefined
    : currentWorkspace.data?.id
  const currentIngest = useQuery(
    {
      queryKey: currentWorkspaceId
        ? workspaceIngestKey(currentWorkspaceId)
        : ["workspace", "ingest", "disabled"],
      queryFn: () => readCurrentIngest(requireDesktop(desktop)),
      enabled: Boolean(desktop && currentWorkspaceId),
    },
    queryClient
  )

  const queriedWorkspace = createWorkspace
    ? undefined
    : (currentWorkspace.data ?? undefined)
  const queriedJob = currentIngest.data ?? undefined
  const workspace = state.workspace ?? queriedWorkspace
  const home = state.home ?? workspaceHome.data ?? undefined
  const job =
    queriedJob && !isOlderJob(queriedJob, state.job) ? queriedJob : state.job
  const piConfigured =
    state.piConfigured ?? providerStatus.data?.configured ?? false
  const knownWorkspaces = workspaces.data ?? []
  const activeWorkspaceId = workspace?.id

  useEffect(() => {
    if (!desktop) return
    const unsubscribe = desktop.wiki.onIngestChanged((event) => {
      projectWorkspaceIngestChanged(queryClient, event)
      if (event.workspaceId === activeWorkspaceId) {
        dispatch({ type: "ingest-changed", event })
      }
    })
    return unsubscribe
  }, [activeWorkspaceId, desktop, queryClient])

  const recovering = Boolean(
    desktop &&
    (providerStatus.isPending ||
      currentWorkspace.isPending ||
      workspaces.isPending ||
      workspaceHome.isPending ||
      (Boolean(currentWorkspaceId) && currentIngest.isPending))
  )
  if (desktop === undefined || recovering) {
    return <OpeningScreen />
  }
  if (desktop === null) return <DesktopRequired />
  if (
    (!createWorkspace || state.workspace !== undefined) &&
    piConfigured &&
    workspace?.setupStatus === "ready" &&
    readyElement
  ) {
    return readyElement
  }

  const api = desktop
  const sessionError =
    queryErrorMessage(providerStatus.error) ??
    queryErrorMessage(currentWorkspace.error) ??
    queryErrorMessage(workspaces.error) ??
    queryErrorMessage(workspaceHome.error) ??
    queryErrorMessage(currentIngest.error)
  const error = state.error ?? sessionError
  const actions = useWikiWorkflowActions({
    api,
    state,
    workspace,
    home,
    job,
    queryClient,
    dispatch,
  })

  return (
    <WorkflowStepView
      api={api}
      state={state}
      piConfigured={piConfigured}
      workspace={workspace}
      knownWorkspaces={knownWorkspaces}
      job={job}
      error={error}
      onActivateWorkspace={(workspaceId) =>
        void actions.activateWorkspace(workspaceId)
      }
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
      onCancel={() => void actions.cancelIngest()}
      createWorkspace={createWorkspace}
      home={home}
    />
  )
}

function useWikiWorkflowActions({
  api,
  state,
  workspace,
  home,
  job,
  queryClient,
  dispatch,
}: WorkflowActionsInput): WorkflowActions {
  return {
    chooseHome: async () => {
      dispatch({ type: "operation-started", operation: "home" })
      try {
        const home = await chooseWorkspaceHome(api)
        if (home) {
          queryClient.setQueryData(workspaceHomeKey, home)
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

      let targetWorkspace = workspace
      if (!targetWorkspace) {
        if (!home) {
          dispatch({
            type: "operation-failed",
            message: "Choose an Amend home before creating a workspace.",
          })
          return
        }
        dispatch({ type: "operation-started", operation: "create" })
        try {
          const response = await api.workspaces.create({
            name: state.wikiName,
            domain: state.domain,
          })
          if (!response.ok) {
            dispatch({
              type: "operation-failed",
              message: response.error.message,
            })
            return
          }
          targetWorkspace = response.value
          queryClient.setQueryData(workspaceCurrentKey, targetWorkspace)
          void queryClient.invalidateQueries({ queryKey: workspacesKey })
          dispatch({ type: "workspace-created", workspace: targetWorkspace })
        } catch (cause) {
          dispatch({ type: "operation-failed", message: errorMessage(cause) })
          return
        }
      }

      dispatch({ type: "operation-started", operation: "ingest" })
      try {
        const response = await api.wiki.startIngest({
          documentToken: state.document.token,
          objective: state.objective,
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
          queryClient.setQueryData(
            workspaceIngestKey(targetWorkspace.id),
            snapshot.value
          )
          dispatch({
            type: "ingest-changed",
            event: { workspaceId: targetWorkspace.id, job: snapshot.value },
          })
        }
      } catch (cause) {
        dispatch({ type: "operation-failed", message: errorMessage(cause) })
      }
    },
    activateWorkspace: async (workspaceId) => {
      if (workspaceId === workspace?.id) return
      dispatch({ type: "operation-started", operation: "switch" })
      try {
        const response = await api.workspaces.activate({ workspaceId })
        if (!response.ok) {
          dispatch({
            type: "operation-failed",
            message: response.error.message,
          })
          return
        }
        queryClient.setQueryData(workspaceCurrentKey, response.value)
        void queryClient.invalidateQueries({ queryKey: workspacesKey })
        const ingest = await api.wiki.currentIngest()
        queryClient.setQueryData(
          workspaceIngestKey(response.value.id),
          ingest.ok ? ingest.value : null
        )
        dispatch({
          type: "workspace-activated",
          workspace: response.value,
          job: ingest.ok ? ingest.value : null,
        })
      } catch (cause) {
        dispatch({ type: "operation-failed", message: errorMessage(cause) })
      }
    },
    cancelIngest: async () => {
      if (!job?.cancellable) return
      try {
        const response = await api.wiki.cancelIngest({ jobId: job.id })
        if (!response.ok) {
          dispatch({
            type: "operation-failed",
            message: response.error.message,
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
  workspace,
  knownWorkspaces,
  home,
  createWorkspace,
  job,
  error,
  onActivateWorkspace,
  onProviderConnected,
  onRetryIndex,
  onFieldChange,
  onChooseHome,
  onRegisterDocument,
  onDocumentError,
  onSubmit,
  onCancel,
}: WorkflowStepViewProps) {
  return (
    <WorkflowShell>
      {!createWorkspace && knownWorkspaces.length ? (
        <WorkspaceSwitcher
          workspaces={knownWorkspaces}
          activeWorkspaceId={workspace?.id}
          busy={state.busy === "switch"}
          onActivate={onActivateWorkspace}
        />
      ) : null}
      {!piConfigured ? (
        <PiConnectStep api={api} onConnected={onProviderConnected} />
      ) : workspace?.setupStatus === "ready" &&
        (!job || (job.status === "completed" && job.result)) ? (
        <WikiReadyStep
          workspace={workspace}
          ingest={job?.result}
          refreshing={state.busy === "index"}
          error={error}
          onRetryIndex={onRetryIndex}
        />
      ) : (
        <WikiSetupStep
          workspace={workspace}
          wikiName={state.wikiName}
          domain={state.domain}
          home={home}
          document={state.document}
          sourceFiles={state.sourceFiles}
          objective={state.objective}
          job={job}
          busy={state.busy !== null}
          submitting={state.busy === "create" || state.busy === "ingest"}
          error={error}
          onFieldChange={onFieldChange}
          onChooseHome={onChooseHome}
          onRegisterDocument={onRegisterDocument}
          onDocumentError={onDocumentError}
          onSubmit={onSubmit}
          onCancel={onCancel}
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
      return { ...state, [action.field]: action.value }
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
        job: undefined,
        busy: null,
        error: undefined,
      }
    case "workspace-created":
      return {
        ...state,
        workspace: action.workspace,
        job: undefined,
        document: undefined,
        sourceFiles: undefined,
        busy: null,
        error: undefined,
      }
    case "workspace-activated":
      return applyJob(
        {
          ...state,
          workspace: action.workspace,
          document: undefined,
          sourceFiles: undefined,
          busy: null,
          error: undefined,
        },
        action.job ?? undefined
      )
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
  const workspace =
    job.status === "completed" && job.result && state.workspace
      ? {
          ...state.workspace,
          commitHash: job.result.commitHash,
          setupStatus: "ready" as const,
        }
      : state.workspace
  return { ...state, workspace, job, busy: null, error: undefined }
}

function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  busy,
  onActivate,
}: {
  workspaces: readonly WorkspaceListItem[]
  activeWorkspaceId?: string
  busy: boolean
  onActivate: (workspaceId: string) => void
}) {
  return (
    <div className="mb-8 flex flex-col gap-3 rounded-lg border bg-card p-3 text-card-foreground sm:flex-row sm:items-center sm:justify-between">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
        Workspace
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm text-foreground shadow-xs outline-none disabled:opacity-50"
          value={activeWorkspaceId ?? ""}
          disabled={busy || workspaces.length < 2}
          onChange={(event) => onActivate(event.target.value)}
        >
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
              {workspace.running ? " - running" : ""}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
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
          knowledge base.
        </p>
      </section>
    </main>
  )
}
