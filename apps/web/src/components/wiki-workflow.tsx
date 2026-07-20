import { useEffect, useReducer } from "react"
import type {
  AmendApi,
  IngestPastedSourceResult,
  SourceDocumentSelection,
  WikiIngestJob,
  WorkspaceParentSelection,
  WorkspaceSummary,
} from "@workspace/contract"
import { Spinner } from "@workspace/ui/components/spinner"

import { errorMessage, getAmendApi } from "@/lib/amend-client"

import { PiConnectStep } from "./pi-connect-step"
import { WikiReadyStep } from "./wiki-ready-step"
import { WikiSetupStep } from "./wiki-setup-step"
import { WorkflowShell } from "./wiki-workflow-ui"

type BusyOperation =
  "location" | "document" | "create" | "ingest" | "index" | null

interface WorkflowState {
  desktop: AmendApi | null | undefined
  recovered: boolean
  piConfigured?: boolean
  busy: BusyOperation
  error?: string
  selection?: WorkspaceParentSelection
  workspace?: WorkspaceSummary
  document?: SourceDocumentSelection
  sourceFiles?: File[]
  job?: WikiIngestJob
  wikiName: string
  domain: string
  objective: string
}

type EditableField = "wikiName" | "domain" | "objective"

type WorkflowAction =
  | { type: "desktop-loaded"; desktop: AmendApi | null }
  | {
      type: "session-recovered"
      piConfigured: boolean
      workspace: WorkspaceSummary | null
      job: WikiIngestJob | null
    }
  | { type: "pi-connected" }
  | { type: "field-changed"; field: EditableField; value: string }
  | { type: "operation-started"; operation: Exclude<BusyOperation, null> }
  | { type: "operation-finished" }
  | { type: "operation-failed"; message: string }
  | { type: "location-selected"; selection: WorkspaceParentSelection }
  | {
      type: "document-selected"
      document: SourceDocumentSelection
      sourceFiles: File[]
    }
  | { type: "workspace-created"; workspace: WorkspaceSummary }
  | { type: "ingest-started" }
  | { type: "ingest-changed"; job: WikiIngestJob }
  | { type: "index-refreshed"; index: IngestPastedSourceResult["index"] }

const initialWorkflowState: WorkflowState = {
  desktop: undefined,
  recovered: false,
  busy: null,
  wikiName: "",
  domain: "",
  objective: "",
}

export function WikiWorkflow() {
  const [state, dispatch] = useReducer(workflowReducer, initialWorkflowState)
  const { desktop } = state

  useEffect(() => {
    dispatch({ type: "desktop-loaded", desktop: getAmendApi() })
  }, [])

  useEffect(() => {
    if (!desktop) return
    const unsubscribe = desktop.wiki.onIngestChanged((job) => {
      dispatch({ type: "ingest-changed", job })
    })
    void recoverSession(desktop, dispatch)
    return unsubscribe
  }, [desktop])

  if (desktop === undefined || (desktop !== null && !state.recovered)) {
    return <OpeningScreen />
  }
  if (desktop === null) return <DesktopRequired />

  const api = desktop

  async function chooseLocation() {
    dispatch({ type: "operation-started", operation: "location" })
    try {
      const response = await api.workspace.chooseParent()
      if (!response.ok) {
        dispatch({ type: "operation-failed", message: response.error.message })
      } else if (response.value) {
        dispatch({ type: "location-selected", selection: response.value })
      } else {
        dispatch({ type: "operation-finished" })
      }
    } catch (cause) {
      dispatch({ type: "operation-failed", message: errorMessage(cause) })
    }
  }

  async function registerDocument(file: File) {
    dispatch({ type: "operation-started", operation: "document" })
    try {
      const response = await api.wiki.registerDocument(file)
      if (!response.ok) {
        dispatch({ type: "operation-failed", message: response.error.message })
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
  }

  async function createWiki(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!state.document) {
      dispatch({
        type: "operation-failed",
        message: "Choose the first source document.",
      })
      return
    }

    let workspace = state.workspace
    if (!workspace) {
      if (!state.selection) {
        dispatch({
          type: "operation-failed",
          message: "Choose where Amend should create the wiki.",
        })
        return
      }
      dispatch({ type: "operation-started", operation: "create" })
      try {
        const response = await api.workspace.create({
          selectionToken: state.selection.token,
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
        workspace = response.value
        dispatch({ type: "workspace-created", workspace })
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
        dispatch({ type: "operation-failed", message: response.error.message })
        return
      }
      dispatch({ type: "ingest-started" })
      const snapshot = await api.wiki.currentIngest()
      if (snapshot.ok && snapshot.value?.id === response.value.jobId) {
        dispatch({ type: "ingest-changed", job: snapshot.value })
      }
    } catch (cause) {
      dispatch({ type: "operation-failed", message: errorMessage(cause) })
    }
  }

  async function cancelIngest() {
    if (!state.job?.cancellable) return
    try {
      const response = await api.wiki.cancelIngest({ jobId: state.job.id })
      if (!response.ok) {
        dispatch({ type: "operation-failed", message: response.error.message })
      }
    } catch (cause) {
      dispatch({ type: "operation-failed", message: errorMessage(cause) })
    }
  }

  async function retryIndex() {
    dispatch({ type: "operation-started", operation: "index" })
    try {
      const response = await api.wiki.refreshIndex()
      if (!response.ok) {
        dispatch({ type: "operation-failed", message: response.error.message })
        return
      }
      dispatch({
        type: "index-refreshed",
        index: { status: "ready", summary: response.value },
      })
    } catch (cause) {
      dispatch({ type: "operation-failed", message: errorMessage(cause) })
    }
  }

  function changeField(field: EditableField, value: string) {
    dispatch({ type: "field-changed", field, value })
  }

  return (
    <WorkflowShell>
      {!state.piConfigured ? (
        <PiConnectStep
          api={api}
          onConnected={() => dispatch({ type: "pi-connected" })}
        />
      ) : state.job?.status === "completed" && state.job.result ? (
        <WikiReadyStep
          workspace={state.workspace}
          ingest={state.job.result}
          refreshing={state.busy === "index"}
          error={state.error}
          onRetryIndex={() => void retryIndex()}
        />
      ) : (
        <WikiSetupStep
          workspace={state.workspace}
          wikiName={state.wikiName}
          domain={state.domain}
          location={state.selection?.displayPath}
          document={state.document}
          sourceFiles={state.sourceFiles}
          objective={state.objective}
          job={state.job}
          busy={state.busy !== null}
          submitting={state.busy === "create" || state.busy === "ingest"}
          error={state.error}
          onFieldChange={changeField}
          onChooseLocation={() => void chooseLocation()}
          onRegisterDocument={(file) => void registerDocument(file)}
          onDocumentError={(message) =>
            dispatch({ type: "operation-failed", message })
          }
          onSubmit={createWiki}
          onCancel={() => void cancelIngest()}
        />
      )}
    </WorkflowShell>
  )
}

async function recoverSession(
  api: AmendApi,
  dispatch: React.Dispatch<WorkflowAction>
): Promise<void> {
  try {
    const [status, workspace, job] = await Promise.all([
      api.pi.status(),
      api.workspace.current(),
      api.wiki.currentIngest(),
    ])
    if (!workspace.ok) {
      dispatch({ type: "operation-failed", message: workspace.error.message })
    }
    if (!job.ok) {
      dispatch({ type: "operation-failed", message: job.error.message })
    }
    dispatch({
      type: "session-recovered",
      piConfigured: status.ok && status.value.configured,
      workspace: workspace.ok ? workspace.value : null,
      job: job.ok ? job.value : null,
    })
  } catch (cause) {
    dispatch({ type: "operation-failed", message: errorMessage(cause) })
    dispatch({
      type: "session-recovered",
      piConfigured: false,
      workspace: null,
      job: null,
    })
  }
}

function workflowReducer(
  state: WorkflowState,
  action: WorkflowAction
): WorkflowState {
  switch (action.type) {
    case "desktop-loaded":
      return {
        ...state,
        desktop: action.desktop,
        recovered: action.desktop === null,
      }
    case "session-recovered": {
      const recoveredJob =
        action.job && !isOlderJob(action.job, state.job)
          ? action.job
          : state.job
      return applyJob(
        {
          ...state,
          recovered: true,
          piConfigured: action.piConfigured,
          workspace: action.workspace ?? undefined,
        },
        recoveredJob
      )
    }
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
    case "location-selected":
      return { ...state, selection: action.selection, busy: null }
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
      if (isOlderJob(action.job, state.job)) return state
      return applyJob(state, action.job)
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

function applyJob(state: WorkflowState, job?: WikiIngestJob): WorkflowState {
  if (!job) return { ...state, job: undefined, busy: null }
  if (job.status === "running") {
    return { ...state, job, busy: "ingest", error: undefined }
  }
  return { ...state, job, busy: null, error: undefined }
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
