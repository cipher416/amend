import { useQuery } from "@tanstack/react-query"
import { useNavigate, useRouter } from "@tanstack/react-router"
import type { AmendApi, WikiSummary } from "@workspace/contract"
import { Search01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@workspace/ui/components/command"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"
import { useEffect, useEffectEvent, useState } from "react"

import { searchWiki } from "@/lib/wiki-queries"

const searchDebounceMs = 200

export function WikiSearch({
  desktop,
  wiki,
}: {
  desktop: AmendApi
  wiki: WikiSummary
}) {
  const navigate = useNavigate()
  const queryClient = useRouter().options.context.queryClient
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const searchQuery = query.trim()
  const debouncedSearchQuery = debouncedQuery.trim()
  const waitingForSearch =
    searchQuery.length > 0 && searchQuery !== debouncedSearchQuery
  const search = useQuery(
    {
      queryKey: ["wiki", wiki.id, "search", debouncedSearchQuery],
      queryFn: () =>
        searchWiki(desktop, { query: debouncedSearchQuery, limit: 20 }),
      enabled:
        open && searchQuery.length > 0 && debouncedSearchQuery.length > 0,
    },
    queryClient
  )

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedQuery(searchQuery),
      searchDebounceMs
    )
    return () => window.clearTimeout(timeout)
  }, [searchQuery])

  const toggleSearch = useEffectEvent(() => onOpenChange(!open))

  useEffect(() => {
    function openSearch(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      ) {
        return
      }
      event.preventDefault()
      toggleSearch()
    }

    window.addEventListener("keydown", openSearch, true)
    return () => window.removeEventListener("keydown", openSearch, true)
  }, [])

  function onOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) setQuery("")
  }

  function openResult(path: string) {
    onOpenChange(false)
    void navigate({
      to: "/wiki/$wikiId/$",
      params: { wikiId: wiki.id, _splat: path },
    })
  }

  return (
    <>
      <Button
        className="w-full justify-start shadow-xs"
        size="lg"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <HugeiconsIcon data-icon="inline-start" icon={Search01Icon} />
        <span className="hidden sm:inline">Search wiki</span>
        <span className="sr-only sm:hidden">Search wiki</span>
        <kbd className="ml-auto rounded-sm border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-[0.625rem] font-medium text-muted-foreground">
          Ctrl K
        </kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title={`Search ${wiki.name}`}
        description="Search indexed wiki pages and source material."
        className="w-[calc(100%-2rem)] max-w-3xl border-border/80 bg-popover/95 shadow-2xl backdrop-blur-xl sm:max-w-3xl"
      >
        <Command className="p-2" shouldFilter={false}>
          <CommandInput
            aria-label="Search wiki"
            autoFocus
            placeholder="Search this wiki..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="mt-2">
            {searchQuery ? (
              !waitingForSearch && !search.isFetching ? (
                <CommandEmpty>No matching notes or sources.</CommandEmpty>
              ) : null
            ) : (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                Search titles, concepts, and source material.
              </p>
            )}
            {waitingForSearch || search.isFetching ? (
              <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                <Spinner />
                <span>Searching wiki</span>
              </div>
            ) : null}
            {search.error ? (
              <p className="px-3 py-6 text-sm text-destructive">
                {search.error.message}
              </p>
            ) : null}
            {search.data?.length ? (
              <CommandGroup
                heading={`${search.data.length} ${search.data.length === 1 ? "result" : "results"}`}
              >
                {search.data.map((result) => (
                  <CommandItem
                    key={result.path}
                    value={`${result.title} ${result.path} ${result.snippet}`}
                    onSelect={() => openResult(result.path)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate font-medium">
                        {result.title}
                      </span>
                      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        <span className="min-w-0 truncate font-mono text-[0.6875rem] text-foreground/65">
                          {result.path}
                        </span>
                        {result.heading ? (
                          <span className="min-w-0 truncate">
                            {result.heading}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <Badge variant="secondary">
                      {result.pageType ?? result.sourceKind ?? result.kind}
                    </Badge>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  )
}
