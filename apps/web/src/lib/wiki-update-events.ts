import type { QueryClient } from "@tanstack/react-query"
import type {
  WikiIngestJob,
  WikiListItem,
  WikiUpdateChangedEvent,
  WikiUpdateSession,
} from "@workspace/contract"

import { wikiIngestKey, wikiUpdateKey, wikisKey } from "./wiki-queries"

export function projectWikiUpdateChanged(
  queryClient: QueryClient,
  event: WikiUpdateChangedEvent
) {
  const current = queryClient.getQueryData<WikiUpdateSession | null>(
    wikiUpdateKey(event.wikiId)
  )
  if (
    current &&
    event.session &&
    current.id === event.session.id &&
    event.session.revision < current.revision
  ) {
    return
  }
  queryClient.setQueryData(wikiUpdateKey(event.wikiId), event.session)
  const ingest = queryClient.getQueryData<WikiIngestJob>(
    wikiIngestKey(event.wikiId)
  )
  queryClient.setQueryData<readonly WikiListItem[]>(wikisKey, (wikis) =>
    wikis?.map((wiki) =>
      wiki.id === event.wikiId
        ? {
            ...wiki,
            running:
              ingest?.status === "running" ||
              event.session?.status === "running" ||
              event.session?.status === "applying",
          }
        : wiki
    )
  )
}
