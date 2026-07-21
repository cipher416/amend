import { useMutation, useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import type {
  AmendApi,
  WikiListItem,
  WikiSummary,
  WikiFileTreeItem,
} from "@workspace/contract"
import { createContext, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"

import { errorMessage } from "@/lib/amend-client"
import { projectWikiIngestChanged } from "@/lib/wiki-ingest-events"
import {
  activateWikiById,
  listFiles,
  listWikis,
  readCurrentWiki,
  wikiCurrentKey,
  wikiFilesKey,
  wikisKey,
} from "@/lib/wiki-queries"

export type WikiBusy = "switch" | "files" | "file" | null

interface WikiSessionValue {
  desktop: AmendApi
  opening: boolean
  wiki?: WikiSummary
  wikis: readonly WikiListItem[]
  files: readonly WikiFileTreeItem[]
  busy: WikiBusy
  error?: string
}

const WikiSessionContext = createContext<WikiSessionValue | null>(null)

export function WikiSession({
  desktop,
  wikiId,
  children,
}: {
  desktop: AmendApi
  wikiId: string
  children: ReactNode
}) {
  const session = useWikiSessionState({ desktop, wikiId })
  return (
    <WikiSessionContext.Provider value={session}>
      {children}
    </WikiSessionContext.Provider>
  )
}

export function useWikiSession(): WikiSessionValue {
  const session = useContext(WikiSessionContext)
  if (!session) {
    throw new Error("Wiki content must render inside WikiSession")
  }
  return session
}

function useWikiSessionState({
  desktop,
  wikiId,
}: {
  desktop: AmendApi
  wikiId: string
}): WikiSessionValue {
  const queryClient = useRouter().options.context.queryClient
  const [operationError, setOperationError] = useState<string>()
  const currentWiki = useQuery(
    {
      queryKey: wikiCurrentKey,
      queryFn: () => readCurrentWiki(desktop),
    },
    queryClient
  )
  const wikis = useQuery(
    {
      queryKey: wikisKey,
      queryFn: () => listWikis(desktop),
    },
    queryClient
  )
  const activateWiki = useMutation(
    {
      mutationFn: (nextWikiId: string) => activateWikiById(desktop, nextWikiId),
      onMutate: () => setOperationError(undefined),
      onSuccess: (wiki) => {
        queryClient.setQueryData(wikiCurrentKey, wiki)
        void queryClient.invalidateQueries({ queryKey: wikisKey })
        void queryClient.invalidateQueries({
          queryKey: wikiFilesKey(wiki.id),
        })
      },
      onError: (cause) => setOperationError(errorMessage(cause)),
    },
    queryClient
  )
  useEffect(() => {
    if (currentWiki.isPending || activateWiki.isPending) return
    if (currentWiki.data?.id === wikiId) return
    activateWiki.mutate(wikiId)
  }, [activateWiki, currentWiki.data?.id, currentWiki.isPending, wikiId])

  const activeWiki = currentWiki.data
  const readyWiki = activeWiki?.setupStatus === "ready" ? activeWiki : undefined
  const routeMatchesActiveWiki = readyWiki?.id === wikiId
  const files = useQuery(
    {
      queryKey: readyWiki
        ? wikiFilesKey(readyWiki.id)
        : ["wiki", "files", "disabled"],
      queryFn: () => listFiles(desktop),
      enabled: Boolean(readyWiki && routeMatchesActiveWiki),
    },
    queryClient
  )

  useEffect(
    () =>
      desktop.wiki.onIngestChanged((event) =>
        projectWikiIngestChanged(queryClient, event)
      ),
    [desktop, queryClient]
  )

  const resolvingRouteWiki = Boolean(!readyWiki && !activateWiki.isError)
  const opening = currentWiki.isPending || wikis.isPending || resolvingRouteWiki
  const busy: WikiBusy = activateWiki.isPending
    ? "switch"
    : files.isPending && files.fetchStatus !== "idle"
      ? "files"
      : null
  const error =
    operationError ??
    queryErrorMessage(currentWiki.error) ??
    queryErrorMessage(wikis.error) ??
    queryErrorMessage(files.error)

  return {
    desktop,
    opening,
    wiki: readyWiki,
    wikis: wikis.data ?? [],
    files: files.data ?? [],
    busy,
    error,
  }
}

function queryErrorMessage(error: Error | null): string | undefined {
  return error ? errorMessage(error) : undefined
}
