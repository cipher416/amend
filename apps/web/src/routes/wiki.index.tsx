import { useQuery } from "@tanstack/react-query"
import { Navigate, createFileRoute, useRouter } from "@tanstack/react-router"

import { errorMessage, useAmendApi } from "@/lib/amend-client"
import { readCurrentWiki, wikiCurrentKey } from "@/lib/wiki-queries"

export const Route = createFileRoute("/wiki/")({
  component: WikiIndexRoute,
})

function WikiIndexRoute() {
  const desktop = useAmendApi()
  const queryClient = useRouter().options.context.queryClient
  const currentWiki = useQuery(
    {
      queryKey: wikiCurrentKey,
      queryFn: () => readCurrentWiki(requireDesktop(desktop)),
      enabled: Boolean(desktop),
    },
    queryClient
  )

  if (desktop === null || currentWiki.data === null) {
    return <Navigate to="/" search={{ createWiki: false }} />
  }
  if (currentWiki.error) {
    return (
      <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
        <p className="max-w-sm text-sm text-muted-foreground">
          {errorMessage(currentWiki.error)}
        </p>
      </main>
    )
  }
  if (currentWiki.data) {
    return (
      <Navigate
        to="/wiki/$wikiId"
        params={{ wikiId: currentWiki.data.id }}
        replace
      />
    )
  }
  return null
}

function requireDesktop<T>(value: T | null | undefined): T {
  if (!value) throw new Error("Amend desktop API is unavailable")
  return value
}
