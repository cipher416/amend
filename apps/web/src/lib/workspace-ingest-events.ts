import type { QueryClient } from "@tanstack/react-query"
import type {
  WikiIngestChangedEvent,
  WikiIngestJob,
  WorkspaceListItem,
  WorkspaceSummary,
} from "@workspace/contract"

import {
  workspaceCurrentKey,
  workspaceFilesKey,
  workspaceIngestKey,
  workspacesKey,
} from "./workspace-queries"

export function projectWorkspaceIngestChanged(
  queryClient: QueryClient,
  event: WikiIngestChangedEvent
): void {
  const currentJob = queryClient.getQueryData<WikiIngestJob>(
    workspaceIngestKey(event.workspaceId)
  )
  if (
    currentJob?.id === event.job.id &&
    event.job.revision < currentJob.revision
  ) {
    return
  }

  queryClient.setQueryData<readonly WorkspaceListItem[]>(
    workspacesKey,
    (workspaces) =>
      workspaces?.map((workspace) =>
        workspace.id === event.workspaceId
          ? { ...workspace, running: event.job.status === "running" }
          : workspace
      )
  )
  queryClient.setQueryData(workspaceIngestKey(event.workspaceId), event.job)

  const result = event.job.result
  if (event.job.status === "completed" && result) {
    queryClient.setQueryData<WorkspaceSummary | null>(
      workspaceCurrentKey,
      (workspace) =>
        workspace?.id === event.workspaceId
          ? {
              ...workspace,
              commitHash: result.commitHash,
              setupStatus: "ready",
            }
          : workspace
    )
  }

  if (event.job.status !== "running") {
    void queryClient.invalidateQueries({
      queryKey: workspaceFilesKey(event.workspaceId),
    })
  }
}
