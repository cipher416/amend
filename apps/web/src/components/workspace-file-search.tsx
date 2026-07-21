import type { WikiFileContent } from "@workspace/contract"
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { useEffect, useEffectEvent, useRef, useState } from "react"
import type { RefObject } from "react"

const allMatchesHighlight = "workspace-file-search"
const currentMatchHighlight = "workspace-file-search-current"

export function WorkspaceFileSearch({
  file,
  contentRef,
}: {
  file?: WikiFileContent
  contentRef: RefObject<HTMLElement | null>
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [matches, setMatches] = useState<readonly Range[]>([])
  const [currentMatch, setCurrentMatch] = useState(0)

  const canSearch = file?.mediaType !== undefined && file.mediaType !== "binary"
  const openSearch = useEffectEvent(() => {
    if (!canSearch || document.querySelector("[data-slot=dialog-content]"))
      return
    setOpen(true)
  })

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "f"
      ) {
        return
      }
      event.preventDefault()
      openSearch()
    }

    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    const nextMatches = query
      ? findTextMatches(contentRef.current, query)
      : []
    setMatches(nextMatches)
    setCurrentMatch(0)
  }, [contentRef, file?.content, file?.path, query])

  useEffect(() => {
    if (!matches.length) {
      clearHighlights()
      return
    }

    updateHighlights(matches, currentMatch)
    const match = matches[currentMatch % matches.length]
    const parentElement = match.startContainer.parentElement
    parentElement?.scrollIntoView({
      behavior: "auto",
      block: "center",
    })
    return clearHighlights
  }, [currentMatch, matches])

  function closeSearch() {
    setOpen(false)
    setQuery("")
  }

  function moveMatch(direction: 1 | -1) {
    if (!matches.length) return
    setCurrentMatch(
      (match) => (match + direction + matches.length) % matches.length
    )
  }

  if (!canSearch) return null

  if (!open) {
    return (
      <Button
        aria-label="Find in file"
        size="icon"
        title="Find in file (Ctrl+F)"
        variant="ghost"
        onClick={openSearch}
      >
        <HugeiconsIcon icon={Search01Icon} />
      </Button>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5" role="search">
      <div className="relative min-w-0">
        <HugeiconsIcon
          aria-hidden="true"
          icon={Search01Icon}
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          className="h-8 w-48 bg-muted/50 pr-16 pl-8 text-xs shadow-xs sm:w-64"
          placeholder="Find in this file"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "Enter") {
              event.preventDefault()
              moveMatch(event.shiftKey ? -1 : 1)
            } else if (event.key === "ArrowUp") {
              event.preventDefault()
              moveMatch(-1)
            } else if (event.key === "Escape") {
              event.preventDefault()
              closeSearch()
            }
          }}
        />
        <span
          aria-live="polite"
          className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[0.625rem] tabular-nums text-muted-foreground"
        >
          {query ? (matches.length ? `${currentMatch + 1}/${matches.length}` : "0/0") : ""}
        </span>
      </div>
      <Button
        aria-label="Previous match"
        disabled={!matches.length}
        size="icon-sm"
        title="Previous match"
        variant="ghost"
        onClick={() => moveMatch(-1)}
      >
        <HugeiconsIcon icon={ArrowUp01Icon} />
      </Button>
      <Button
        aria-label="Next match"
        disabled={!matches.length}
        size="icon-sm"
        title="Next match"
        variant="ghost"
        onClick={() => moveMatch(1)}
      >
        <HugeiconsIcon icon={ArrowDown01Icon} />
      </Button>
      <Button
        aria-label="Close find in file"
        size="icon-sm"
        title="Close find in file"
        variant="ghost"
        onClick={closeSearch}
      >
        <HugeiconsIcon icon={Cancel01Icon} />
      </Button>
    </div>
  )
}

function findTextMatches(
  root: HTMLElement | null,
  query: string
): readonly Range[] {
  if (!root) return []

  const matches: Range[] = []
  const normalizedQuery = query.toLocaleLowerCase()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()

  while (node) {
    const text = node.textContent ?? ""
    const normalizedText = text.toLocaleLowerCase()
    let offset = normalizedText.indexOf(normalizedQuery)

    while (offset !== -1) {
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset + query.length)
      matches.push(range)
      offset = normalizedText.indexOf(normalizedQuery, offset + query.length)
    }

    node = walker.nextNode()
  }

  return matches
}

type HighlightRegistry = {
  set: (name: string, ranges: Set<Range>) => void
  delete: (name: string) => void
}

type HighlightConstructor = new (...ranges: Range[]) => Set<Range>

function updateHighlights(matches: readonly Range[], currentMatch: number) {
  const registry = getHighlightRegistry()
  const Highlight = getHighlightConstructor()
  if (!registry || !Highlight) return

  clearHighlights()
  if (!matches.length) return

  const current = matches[currentMatch % matches.length]
  registry.set(allMatchesHighlight, new Highlight(...matches))
  registry.set(currentMatchHighlight, new Highlight(current))
}

function clearHighlights() {
  const registry = getHighlightRegistry()
  registry?.delete(allMatchesHighlight)
  registry?.delete(currentMatchHighlight)
}

function getHighlightRegistry(): HighlightRegistry | undefined {
  const css = globalThis.CSS as unknown as
    | { highlights?: HighlightRegistry }
    | undefined
  return css?.highlights
}

function getHighlightConstructor(): HighlightConstructor | undefined {
  return (globalThis as typeof globalThis & { Highlight?: HighlightConstructor })
    .Highlight
}
