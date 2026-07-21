import type { QueryClient } from "@tanstack/react-query"
import type {
  WikiIngestChangedEvent,
  WikiIngestJob,
  WikiListItem,
  WikiSummary,
} from "@workspace/contract"

import {
  wikiCurrentKey,
  wikiFilesKey,
  wikiIngestKey,
  wikisKey,
} from "./wiki-queries"

export function projectWikiIngestChanged(
  queryClient: QueryClient,
  event: WikiIngestChangedEvent
): void {
  const currentJob = queryClient.getQueryData<WikiIngestJob>(
    wikiIngestKey(event.wikiId)
  )
  if (
    currentJob?.id === event.job.id &&
    event.job.revision < currentJob.revision
  ) {
    return
  }

  queryClient.setQueryData<readonly WikiListItem[]>(wikisKey, (wikis) =>
    wikis?.map((wiki) =>
      wiki.id === event.wikiId
        ? { ...wiki, running: event.job.status === "running" }
        : wiki
    )
  )
  queryClient.setQueryData(wikiIngestKey(event.wikiId), event.job)

  const result = event.job.result
  if (event.job.status === "completed" && result) {
    queryClient.setQueryData<WikiSummary | null>(wikiCurrentKey, (wiki) =>
      wiki?.id === event.wikiId
        ? {
            ...wiki,
            commitHash: result.commitHash,
            setupStatus: "ready",
          }
        : wiki
    )
  }

  if (event.job.status !== "running") {
    void queryClient.invalidateQueries({ queryKey: wikiFilesKey(event.wikiId) })
  }
}
