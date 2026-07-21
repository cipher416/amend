import { QueryClient } from "@tanstack/react-query"
import type {
  WikiIngestChangedEvent,
  WikiIngestJob,
  WorkspaceSummary,
} from "@workspace/contract"
import { describe, expect, it } from "vitest"

import { projectWorkspaceIngestChanged } from "./workspace-ingest-events"
import {
  workspaceCurrentKey,
  workspaceIngestKey,
  workspacesKey,
} from "./workspace-queries"

describe("projectWorkspaceIngestChanged", () => {
  it("ignores stale revisions before changing workspace caches", () => {
    const queryClient = new QueryClient()
    const currentJob = completedJob(2)
    queryClient.setQueryData(workspaceIngestKey("workspace-id"), currentJob)
    queryClient.setQueryData(workspacesKey, [
      {
        id: "workspace-id",
        name: "Reliability Wiki",
        displayPath: "/research/Reliability Wiki",
        active: true,
        running: false,
      },
    ])
    queryClient.setQueryData<WorkspaceSummary>(workspaceCurrentKey, {
      id: "workspace-id",
      name: "Reliability Wiki",
      domain: "Database reliability engineering",
      displayPath: "/research/Reliability Wiki",
      commitHash: "new-commit",
      setupStatus: "ready",
    })

    projectWorkspaceIngestChanged(queryClient, {
      workspaceId: "workspace-id",
      job: { ...currentJob, revision: 1, status: "running", result: undefined },
    })

    expect(
      queryClient.getQueryData<WikiIngestJob>(
        workspaceIngestKey("workspace-id")
      )
    ).toEqual(currentJob)
    expect(queryClient.getQueryData(workspacesKey)).toMatchObject([
      { running: false },
    ])
    expect(
      queryClient.getQueryData<WorkspaceSummary>(workspaceCurrentKey)
    ).toMatchObject({
      commitHash: "new-commit",
      setupStatus: "ready",
    })
  })
})

function completedJob(revision: number): WikiIngestChangedEvent["job"] {
  return {
    id: "ingest_1234567890",
    title: "Paper",
    status: "completed",
    phase: "indexing",
    message: "Done",
    startedAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:01.000Z",
    revision,
    cancellable: false,
    result: {
      runId: "run-id",
      commitHash: "new-commit",
      changedFiles: ["concepts/paper.md"],
      summary: "Done",
      index: {
        status: "ready",
        summary: {
          commitHash: "new-commit",
          added: 1,
          updated: 0,
          removed: 0,
          unchanged: 0,
        },
      },
    },
  }
}
