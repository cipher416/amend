import { useMutation, useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import type {
  AmendApi,
  WorkspaceListItem,
  WorkspaceSummary,
  WikiFileTreeItem,
} from "@workspace/contract"
import { createContext, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"

import { errorMessage } from "@/lib/amend-client"
import { projectWorkspaceIngestChanged } from "@/lib/workspace-ingest-events"
import {
  activateWorkspaceById,
  listFiles,
  listWorkspaces,
  readCurrentWorkspace,
  workspaceCurrentKey,
  workspaceFilesKey,
  workspacesKey,
} from "@/lib/workspace-queries"

export type WorkspaceBusy = "switch" | "files" | "file" | null

interface WorkspaceSessionValue {
  desktop: AmendApi
  opening: boolean
  workspace?: WorkspaceSummary
  workspaces: readonly WorkspaceListItem[]
  files: readonly WikiFileTreeItem[]
  busy: WorkspaceBusy
  error?: string
}

const WorkspaceSessionContext = createContext<WorkspaceSessionValue | null>(
  null
)

export function WorkspaceSession({
  desktop,
  workspaceId,
  children,
}: {
  desktop: AmendApi
  workspaceId: string
  children: ReactNode
}) {
  const session = useWorkspaceSessionState({ desktop, workspaceId })
  return (
    <WorkspaceSessionContext.Provider value={session}>
      {children}
    </WorkspaceSessionContext.Provider>
  )
}

export function useWorkspaceSession(): WorkspaceSessionValue {
  const session = useContext(WorkspaceSessionContext)
  if (!session) {
    throw new Error("Workspace content must render inside WorkspaceSession")
  }
  return session
}

function useWorkspaceSessionState({
  desktop,
  workspaceId,
}: {
  desktop: AmendApi
  workspaceId: string
}): WorkspaceSessionValue {
  const queryClient = useRouter().options.context.queryClient
  const [operationError, setOperationError] = useState<string>()
  const currentWorkspace = useQuery(
    {
      queryKey: workspaceCurrentKey,
      queryFn: () => readCurrentWorkspace(desktop),
    },
    queryClient
  )
  const workspaces = useQuery(
    {
      queryKey: workspacesKey,
      queryFn: () => listWorkspaces(desktop),
    },
    queryClient
  )
  const activateWorkspace = useMutation(
    {
      mutationFn: (nextWorkspaceId: string) =>
        activateWorkspaceById(desktop, nextWorkspaceId),
      onMutate: () => setOperationError(undefined),
      onSuccess: (workspace) => {
        queryClient.setQueryData(workspaceCurrentKey, workspace)
        void queryClient.invalidateQueries({ queryKey: workspacesKey })
        void queryClient.invalidateQueries({
          queryKey: workspaceFilesKey(workspace.id),
        })
      },
      onError: (cause) => setOperationError(errorMessage(cause)),
    },
    queryClient
  )
  useEffect(() => {
    if (currentWorkspace.isPending || activateWorkspace.isPending) return
    if (currentWorkspace.data?.id === workspaceId) return
    activateWorkspace.mutate(workspaceId)
  }, [
    activateWorkspace,
    currentWorkspace.data?.id,
    currentWorkspace.isPending,
    workspaceId,
  ])

  const activeWorkspace = currentWorkspace.data
  const readyWorkspace =
    activeWorkspace?.setupStatus === "ready" ? activeWorkspace : undefined
  const routeMatchesActiveWorkspace = readyWorkspace?.id === workspaceId
  const files = useQuery(
    {
      queryKey: readyWorkspace
        ? workspaceFilesKey(readyWorkspace.id)
        : ["workspace", "files", "disabled"],
      queryFn: () => listFiles(desktop),
      enabled: Boolean(readyWorkspace && routeMatchesActiveWorkspace),
    },
    queryClient
  )

  useEffect(
    () =>
      desktop.wiki.onIngestChanged((event) =>
        projectWorkspaceIngestChanged(queryClient, event)
      ),
    [desktop, queryClient]
  )

  const resolvingRouteWorkspace = Boolean(
    !readyWorkspace && !activateWorkspace.isError
  )
  const opening =
    currentWorkspace.isPending ||
    workspaces.isPending ||
    resolvingRouteWorkspace
  const busy: WorkspaceBusy = activateWorkspace.isPending
    ? "switch"
    : files.isPending && files.fetchStatus !== "idle"
      ? "files"
      : null
  const error =
    operationError ??
    queryErrorMessage(currentWorkspace.error) ??
    queryErrorMessage(workspaces.error) ??
    queryErrorMessage(files.error)

  return {
    desktop,
    opening,
    workspace: readyWorkspace,
    workspaces: workspaces.data ?? [],
    files: files.data ?? [],
    busy,
    error,
  }
}

function queryErrorMessage(error: Error | null): string | undefined {
  return error ? errorMessage(error) : undefined
}
