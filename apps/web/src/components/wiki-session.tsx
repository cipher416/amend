import { useMutation, useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import type {
  AmendApi,
  WikiIngestJob,
  WikiListItem,
  WikiSummary,
  WikiFileTreeItem,
} from "@workspace/contract"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
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
  wikiIngestKey,
  wikisKey,
} from "@/lib/wiki-queries"

export type WikiBusy = "switch" | "files" | "file" | null

export interface WikiIngestCompletionNotice {
  jobId: string
  wikiName: string
}

interface WikiSessionValue {
  desktop: AmendApi
  opening: boolean
  wiki?: WikiSummary
  wikis: readonly WikiListItem[]
  files: readonly WikiFileTreeItem[]
  busy: WikiBusy
  error?: string
  ingestCompletionNotice?: WikiIngestCompletionNotice
  dismissIngestCompletionNotice: (jobId: string) => void
  trackBackgroundIngest: (input: {
    jobId: string
    wikiId: string
    wikiName: string
  }) => void
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
  const [ingestCompletionNotices, setIngestCompletionNotices] = useState<
    readonly WikiIngestCompletionNotice[]
  >([])
  const trackedBackgroundIngests = useRef(new Map<string, string>())
  const notifiedBackgroundIngests = useRef(new Set<string>())

  const showCompletedBackgroundIngest = useCallback(
    (event: { wikiId: string; job: WikiIngestJob }) => {
      const key = `${event.wikiId}:${event.job.id}`
      const wikiName = trackedBackgroundIngests.current.get(key)
      if (
        !wikiName ||
        notifiedBackgroundIngests.current.has(key) ||
        event.job.status !== "completed"
      ) {
        return
      }

      notifiedBackgroundIngests.current.add(key)
      trackedBackgroundIngests.current.delete(key)
      setIngestCompletionNotices((notices) => [
        ...notices,
        { jobId: event.job.id, wikiName },
      ])
    },
    []
  )

  const trackBackgroundIngest = useCallback(
    ({
      jobId,
      wikiId: startedWikiId,
      wikiName,
    }: {
      jobId: string
      wikiId: string
      wikiName: string
    }) => {
      const key = `${startedWikiId}:${jobId}`
      trackedBackgroundIngests.current.set(key, wikiName)
      const currentJob = queryClient.getQueryData<WikiIngestJob>(
        wikiIngestKey(startedWikiId)
      )
      if (currentJob?.id === jobId) {
        showCompletedBackgroundIngest({
          wikiId: startedWikiId,
          job: currentJob,
        })
      }
    },
    [queryClient, showCompletedBackgroundIngest]
  )

  const dismissIngestCompletionNotice = useCallback((jobId: string) => {
    setIngestCompletionNotices((notices) =>
      notices[0]?.jobId === jobId
        ? notices.slice(1)
        : notices.filter((notice) => notice.jobId !== jobId)
    )
  }, [])

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
      desktop.wiki.onIngestChanged((event) => {
        projectWikiIngestChanged(queryClient, event)
        showCompletedBackgroundIngest(event)
      }),
    [desktop, queryClient, showCompletedBackgroundIngest]
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
  const ingestCompletionNotice = ingestCompletionNotices[0]

  return {
    desktop,
    opening,
    wiki: readyWiki,
    wikis: wikis.data ?? [],
    files: files.data ?? [],
    busy,
    error,
    ingestCompletionNotice,
    dismissIngestCompletionNotice,
    trackBackgroundIngest,
  }
}

function queryErrorMessage(error: Error | null): string | undefined {
  return error ? errorMessage(error) : undefined
}
