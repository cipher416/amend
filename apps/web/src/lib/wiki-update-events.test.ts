import { QueryClient } from "@tanstack/react-query"
import type { WikiUpdateSession } from "@workspace/contract"
import { describe, expect, it } from "vitest"

import { projectWikiUpdateChanged } from "./wiki-update-events"
import { wikiUpdateKey, wikisKey } from "./wiki-queries"

describe("projectWikiUpdateChanged", () => {
  it("ignores an older snapshot for the same session", () => {
    const queryClient = new QueryClient()
    const current = updateSession(3)
    queryClient.setQueryData(wikiUpdateKey("wiki-id"), current)

    projectWikiUpdateChanged(queryClient, {
      wikiId: "wiki-id",
      session: { ...current, revision: 2, status: "running" },
    })

    expect(
      queryClient.getQueryData<WikiUpdateSession>(wikiUpdateKey("wiki-id"))
    ).toEqual(current)
  })

  it("projects disposal as a null session", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(wikiUpdateKey("wiki-id"), updateSession(3))

    projectWikiUpdateChanged(queryClient, {
      wikiId: "wiki-id",
      session: null,
    })

    expect(queryClient.getQueryData(wikiUpdateKey("wiki-id"))).toBeNull()
  })

  it("projects running state into the wiki picker", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(wikisKey, [
      {
        id: "wiki-id",
        name: "Reliability Wiki",
        displayPath: "/research/Reliability Wiki",
        active: true,
        running: false,
      },
    ])

    projectWikiUpdateChanged(queryClient, {
      wikiId: "wiki-id",
      session: { ...updateSession(1), status: "running", cancellable: true },
    })

    expect(queryClient.getQueryData(wikisKey)).toMatchObject([
      { id: "wiki-id", running: true },
    ])
  })
})

function updateSession(revision: number): WikiUpdateSession {
  return {
    id: "update_12345678",
    wikiId: "wiki-id",
    baseCommit: "base-commit",
    status: "review",
    revision,
    updatedAt: "2026-07-22T12:00:00.000Z",
    cancellable: false,
    messages: [],
    activity: [],
    proposal: {
      summary: "Clarified recovery tradeoffs",
      changedFiles: [
        {
          path: "concepts/write-ahead-logging.md",
          status: "modified",
          additions: 4,
          deletions: 1,
        },
      ],
    },
  }
}
