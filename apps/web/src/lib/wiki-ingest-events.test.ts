import { QueryClient } from "@tanstack/react-query"
import type {
  WikiIngestChangedEvent,
  WikiIngestJob,
  WikiSummary,
} from "@workspace/contract"
import { describe, expect, it } from "vitest"

import { projectWikiIngestChanged } from "./wiki-ingest-events"
import { wikiCurrentKey, wikiIngestKey, wikisKey } from "./wiki-queries"

describe("projectWikiIngestChanged", () => {
  it("ignores stale revisions before changing wiki caches", () => {
    const queryClient = new QueryClient()
    const currentJob = completedJob(2)
    queryClient.setQueryData(wikiIngestKey("wiki-id"), currentJob)
    queryClient.setQueryData(wikisKey, [
      {
        id: "wiki-id",
        name: "Reliability Wiki",
        displayPath: "/research/Reliability Wiki",
        active: true,
        running: false,
      },
    ])
    queryClient.setQueryData<WikiSummary>(wikiCurrentKey, {
      id: "wiki-id",
      name: "Reliability Wiki",
      domain: "Database reliability engineering",
      displayPath: "/research/Reliability Wiki",
      commitHash: "new-commit",
      setupStatus: "ready",
    })

    projectWikiIngestChanged(queryClient, {
      wikiId: "wiki-id",
      job: { ...currentJob, revision: 1, status: "running", result: undefined },
    })

    expect(
      queryClient.getQueryData<WikiIngestJob>(wikiIngestKey("wiki-id"))
    ).toEqual(currentJob)
    expect(queryClient.getQueryData(wikisKey)).toMatchObject([
      { running: false },
    ])
    expect(queryClient.getQueryData<WikiSummary>(wikiCurrentKey)).toMatchObject(
      {
        commitHash: "new-commit",
        setupStatus: "ready",
      }
    )
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
