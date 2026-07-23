// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient } from "@tanstack/react-query"
import type {
  AmendApi,
  AmendResult,
  IngestPastedSourceResult,
  PiLoginEvent,
  WikiIngestChangedEvent,
  WikiIngestJob,
  WikiListItem,
  WikiSummary,
} from "@workspace/contract"
import type { ButtonHTMLAttributes } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { WikiWorkflow } from "./wiki-workflow"

const routeHarness = vi.hoisted(() => ({
  queryClient: undefined as QueryClient | undefined,
}))

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    options: {
      context: {
        queryClient: routeHarness.queryClient,
      },
    },
  }),
}))

vi.mock("@workspace/ui/components/button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string
    size?: string
  }) => <button {...props} />,
}))

// Base UI's real Combobox pulls in `@base-ui/utils`'s external-store hooks,
// which don't render reliably under this Vitest/jsdom setup. Stand in with a
// minimal combobox that supports what these tests exercise: opening on
// click, focusing its search input, and selecting the highlighted option on
// Enter — mirroring how this file already simplifies Button.
vi.mock("@workspace/ui/components/combobox", async () => {
  const React = await import("react")

  interface PickerItem {
    id: string
    name: string
  }

  const ComboboxContext = React.createContext<{
    items: readonly PickerItem[]
    value: PickerItem | null
    onValueChange: (value: PickerItem | null) => void
    open: boolean
    setOpen: (open: boolean) => void
  } | null>(null)

  function useComboboxContext() {
    const context = React.useContext(ComboboxContext)
    if (!context) {
      throw new Error("Combobox parts must be used within a Combobox")
    }
    return context
  }

  function Combobox({
    items,
    value,
    onValueChange,
    children,
  }: {
    items: readonly PickerItem[]
    value: PickerItem | null
    onValueChange: (value: PickerItem | null) => void
    disabled?: boolean
    children: React.ReactNode
  }) {
    const [open, setOpen] = React.useState(false)
    return (
      <ComboboxContext.Provider
        value={{ items, value, onValueChange, open, setOpen }}
      >
        {children}
      </ComboboxContext.Provider>
    )
  }

  function ComboboxTrigger({
    render: trigger,
    children,
  }: {
    render: React.ReactElement<React.ComponentProps<"button">>
    children?: React.ReactNode
  }) {
    const { open, setOpen } = useComboboxContext()
    return React.cloneElement(
      trigger,
      {
        role: "combobox",
        "aria-expanded": open,
        onClick: () => setOpen(!open),
      },
      children
    )
  }

  function ComboboxValue({ placeholder }: { placeholder?: React.ReactNode }) {
    const { value } = useComboboxContext()
    return <>{value ? value.name : placeholder}</>
  }

  function ComboboxContent({ children }: { children: React.ReactNode }) {
    const { open } = useComboboxContext()
    return open ? <div>{children}</div> : null
  }

  function ComboboxInput({ placeholder }: { placeholder?: string }) {
    const { items, onValueChange, setOpen } = useComboboxContext()
    const [highlighted, setHighlighted] = React.useState(0)
    const inputRef = React.useRef<HTMLInputElement>(null)
    React.useEffect(() => {
      inputRef.current?.focus()
    }, [])
    return (
      <input
        ref={inputRef}
        placeholder={placeholder}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault()
            setHighlighted((current) => Math.min(current + 1, items.length - 1))
          } else if (event.key === "ArrowUp") {
            event.preventDefault()
            setHighlighted((current) => Math.max(current - 1, 0))
          } else if (event.key === "Enter") {
            event.preventDefault()
            if (items.length > 0) {
              onValueChange(items[highlighted])
              setOpen(false)
            }
          } else if (event.key === "Escape") {
            setOpen(false)
          }
        }}
        readOnly
      />
    )
  }

  function ComboboxEmpty({ children }: { children: React.ReactNode }) {
    const { items } = useComboboxContext()
    return items.length === 0 ? <div>{children}</div> : null
  }

  function ComboboxList({
    children,
  }: {
    children: (item: PickerItem, index: number) => React.ReactNode
  }) {
    const { items } = useComboboxContext()
    return <div>{items.map((item, index) => children(item, index))}</div>
  }

  function ComboboxItem({
    value,
    children,
  }: {
    value: PickerItem
    children: React.ReactNode
  }) {
    const { onValueChange, setOpen } = useComboboxContext()
    return (
      <div
        role="option"
        onClick={() => {
          onValueChange(value)
          setOpen(false)
        }}
      >
        {children}
      </div>
    )
  }

  return {
    Combobox,
    ComboboxTrigger,
    ComboboxValue,
    ComboboxContent,
    ComboboxInput,
    ComboboxEmpty,
    ComboboxList,
    ComboboxItem,
  }
})

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
    observe(_target: Element) {}
    unobserve(_target: Element) {}
    disconnect() {}
  }
  routeHarness.queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})

afterEach(() => {
  cleanup()
  delete window.amend
  routeHarness.queryClient?.clear()
  routeHarness.queryClient = undefined
})

describe("first source workflow", () => {
  it("creates a wiki from its first document", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()
    window.amend = api
    render(<WikiWorkflow />)

    await createWiki(user)

    await screen.findByText("Wiki ready")
    expect(api.wikis.create).toHaveBeenCalledWith({
      name: "Reliability Wiki",
      domain: "Recovery ordering and replication tradeoffs",
    })
    expect(api.wikis.chooseHome).toHaveBeenCalledOnce()
    expect(api.wiki.startIngest).toHaveBeenCalledWith({
      documentToken: "document_1234567890",
      objective: "Recovery ordering and replication tradeoffs",
    })
  })

  it("requires a wiki home and derives defaults from the first document", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()
    window.amend = api
    render(<WikiWorkflow />)

    await screen.findByRole("heading", { name: "Start a new wiki" })
    expect(
      screen.getByText(
        "Choose where your wikis live, then add a document to get started."
      )
    ).toBeDefined()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error("Expected the document file input")
    expect(input.disabled).toBe(true)
    expect(screen.queryByLabelText("Wiki name")).toBeNull()

    await user.click(screen.getByRole("button", { name: "Wiki home" }))
    expect(input.disabled).toBe(false)
    await user.upload(
      input,
      new File(["source"], "write-ahead-logging.pdf", {
        type: "application/pdf",
      })
    )

    const wikiName = await screen.findByLabelText("Wiki name")
    if (!(wikiName instanceof HTMLInputElement)) {
      throw new Error("Expected the wiki name input")
    }
    expect(wikiName.value).toBe("write-ahead-logging")
    await user.click(screen.getByRole("button", { name: "Build wiki" }))

    expect(api.wikis.create).toHaveBeenCalledWith({
      name: "write-ahead-logging",
      domain: "write-ahead-logging",
    })
    expect(api.wiki.startIngest).toHaveBeenCalledWith({
      documentToken: "document_1234567890",
      objective:
        "Capture the central concepts, evidence, and important tradeoffs relevant to write-ahead-logging.",
    })
  })

  it("keeps a committed ingest and retries only the failed index refresh", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi({
      index: {
        status: "failed",
        error: {
          code: "index-failed",
          message: "The source was saved, but indexing failed.",
        },
      },
    })
    window.amend = api
    render(<WikiWorkflow />)

    await createWiki(user)

    await screen.findByText("Search index unavailable")
    await user.click(screen.getByRole("button", { name: "Retry index" }))

    expect(api.wiki.refreshIndex).toHaveBeenCalledOnce()
    expect(screen.queryByRole("button", { name: "Retry index" })).toBeNull()
    expect(api.wiki.startIngest).toHaveBeenCalledOnce()
  })

  it("reconnects to a running main-process ingest after a renderer reload", async () => {
    const api = createDesktopApi({
      wiki: wikiSummary,
      job: createJob({
        status: "running",
        phase: "writing",
        message: "Writing and linking wiki pages",
        cancellable: true,
      }),
    })
    window.amend = api
    render(<WikiWorkflow />)

    await screen.findByRole("heading", { name: "Building your wiki" })
    expect(
      screen.getByText(
        "We're reading, organizing, and linking your first document. This may take a few minutes."
      )
    ).toBeDefined()
    expect(screen.queryByText("Writing and linking wiki pages")).toBeNull()
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull()
    expect(api.wikis.current).toHaveBeenCalledOnce()
    expect(api.wiki.currentIngest).toHaveBeenCalledOnce()
  })

  it("restores a completed wiki without returning to source setup", async () => {
    const api = createDesktopApi({
      wiki: { ...wikiSummary, setupStatus: "ready" },
    })
    window.amend = api
    render(<WikiWorkflow />)

    await screen.findByText("Wiki ready")
    expect(
      screen.getByText("Your existing wiki is ready to browse.")
    ).toBeDefined()
    expect(
      screen.queryByRole("heading", { name: "Start a new wiki" })
    ).toBeNull()
  })

  it("starts sibling creation even when a wiki is already active", async () => {
    const api = createDesktopApi({
      wiki: { ...wikiSummary, setupStatus: "ready" },
    })
    window.amend = api
    render(<WikiWorkflow createWiki />)

    await screen.findByRole("heading", { name: "Start a new wiki" })
  })

  it("uses resume-oriented copy for an existing wiki awaiting its first source", async () => {
    const api = createDesktopApi({ wiki: wikiSummary })
    window.amend = api
    render(<WikiWorkflow />)

    await screen.findByRole("heading", {
      name: "Finish setting up your wiki",
    })
    expect(
      screen.getByText("Add the first document to finish setting up this wiki.")
    ).toBeDefined()
  })

  it("creates a sibling wiki only after its first source is selected", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi({
      wiki: { ...wikiSummary, setupStatus: "ready" },
    })
    api.wiki.registerDocument = vi.fn(async () => {
      expect(api.wikis.create).not.toHaveBeenCalled()
      return success({
        token: "document_1234567890",
        displayName: "write-ahead-logging.pdf",
        suggestedTitle: "write-ahead-logging",
      })
    })
    window.amend = api
    render(<WikiWorkflow createWiki />)

    await createWiki(user)

    expect(api.wiki.startIngest).toHaveBeenCalledOnce()
  })

  it("shows the configured wiki home read-only when creating a sibling wiki", async () => {
    const api = createDesktopApi({
      wiki: { ...wikiSummary, setupStatus: "ready" },
      home: { displayPath: "/research" },
    })
    window.amend = api
    render(<WikiWorkflow createWiki />)

    const home = await screen.findByLabelText("Wiki home")
    expect(
      screen.getByText(
        "Add a document and Amend will turn it into a local, Git-backed wiki."
      )
    ).toBeDefined()
    expect(home.tagName).toBe("P")
    expect(screen.queryByRole("button", { name: "Wiki home" })).toBeNull()
  })

  it("explains that the browser scaffold cannot access local wiki data", async () => {
    render(<WikiWorkflow />)

    await screen.findByText("Your wiki lives on your machine.")
  })

  it("renders the active wiki in the app shell", async () => {
    const api = createDesktopApi({
      wiki: { ...wikiSummary, setupStatus: "ready" },
      knownWikis: [{ ...wikiSummary, setupStatus: "ready" }, secondWikiSummary],
    })
    window.amend = api
    render(<WikiWorkflow />)

    await screen.findByText("Wiki ready")
    await screen.findByText(wikiSummary.displayPath)
  })
})

describe("Pi connection gate", () => {
  it("blocks onboarding until a model provider is connected", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi({ piConfigured: false })
    api.providers.list = vi.fn(async () =>
      success([{ id: "zai", name: "ZAI Coding Plan (Global)" }])
    )
    api.providers.listModels = vi.fn(async () =>
      success([{ id: "glm-5-turbo", name: "GLM-5-Turbo" }])
    )
    window.amend = api
    render(<WikiWorkflow />)

    await screen.findByText("Connect a model provider")
    expect(screen.queryByRole("heading", { name: "Create wiki" })).toBeNull()

    await user.click(
      screen.getByRole("button", { name: "Or connect with an API key" })
    )
    await user.click(screen.getByRole("combobox", { name: "Provider" }))
    const providerSearch = await screen.findByPlaceholderText(
      "Search providers..."
    )
    expect(document.activeElement).toBe(providerSearch)
    await user.keyboard("{ArrowDown}{Enter}")
    await user.type(screen.getByLabelText("API key"), "sk-test-key")
    await user.click(screen.getByRole("button", { name: "Save and continue" }))

    const modelPicker = await screen.findByRole("combobox", {
      name: "Default model",
    })
    expect(api.providers.connectWithApiKey).toHaveBeenCalledWith({
      provider: "zai",
      apiKey: "sk-test-key",
    })

    await user.click(modelPicker)
    const modelSearch = await screen.findByPlaceholderText("Search models...")
    expect(document.activeElement).toBe(modelSearch)
    await user.keyboard("{ArrowDown}{Enter}")
    await user.click(screen.getByRole("button", { name: "Continue" }))

    expect(api.providers.setDefaultModel).toHaveBeenCalledWith({
      provider: "zai",
      model: "glm-5-turbo",
    })
    await screen.findByRole("heading", { name: "Start a new wiki" })
  })

  it("loads the provider models once OAuth completes", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi({ piConfigured: false })
    api.providers.listModels = vi.fn(async () =>
      success([{ id: "claude-sonnet", name: "Claude Sonnet" }])
    )
    window.amend = api
    render(<WikiWorkflow />)

    await screen.findByText("Connect a model provider")
    await user.click(
      screen.getByRole("button", { name: "Connect Anthropic (Claude Pro/Max)" })
    )
    await act(() => {
      api.emitOAuthEvent({ loginId: "login-id", type: "completed" })
    })

    await user.click(
      await screen.findByRole("combobox", { name: "Default model" })
    )
    await screen.findByRole("option", { name: "Claude Sonnet" })
    expect(api.providers.listModels).toHaveBeenCalledOnce()
    expect(api.providers.listModels).toHaveBeenCalledWith({
      provider: "anthropic",
    })
  })
})

type MockAmendApi = AmendApi & {
  emitOAuthEvent: (event: PiLoginEvent) => void
}

function createDesktopApi(
  options: {
    wiki?: WikiSummary
    job?: WikiIngestJob
    index?: IngestPastedSourceResult["index"]
    piConfigured?: boolean
    knownWikis?: readonly WikiSummary[]
    home?: { displayPath: string }
  } = {}
): MockAmendApi {
  let wiki = options.wiki ?? null
  let currentJob = options.job ?? null
  const knownWikis = [...(options.knownWikis ?? [])]
  if (wiki && !knownWikis.some(({ id }) => id === wiki?.id)) {
    knownWikis.push(wiki)
  }
  const wikiItems: WikiListItem[] = knownWikis.map((candidate) =>
    listItem(
      candidate,
      candidate.id === wiki?.id,
      candidate.id === wiki?.id && currentJob?.status === "running"
    )
  )
  const listeners = new Set<(event: WikiIngestChangedEvent) => void>()
  const piListeners = new Set<(event: PiLoginEvent) => void>()
  const api: MockAmendApi = {
    runtime: "electron",
    platform: "linux",
    appearance: {
      setTheme: vi.fn(async () => success(null)),
    },
    providers: {
      status: vi.fn(async () =>
        success({ configured: options.piConfigured ?? true })
      ),
      list: vi.fn(async () => success([])),
      listModels: vi.fn(async () => success([])),
      startOAuth: vi.fn(async () => success({ loginId: "login-id" })),
      respondToOAuthPrompt: vi.fn(async () => success(null)),
      cancelOAuth: vi.fn(async () => success(null)),
      connectWithApiKey: vi.fn(async () => success(null)),
      setDefaultModel: vi.fn(async () => success(null)),
      onOAuthEvent: vi.fn((listener) => {
        piListeners.add(listener)
        return () => piListeners.delete(listener)
      }),
    },
    wikis: {
      chooseHome: vi.fn(async () => success({ displayPath: "/research" })),
      home: vi.fn(async () => success(options.home ?? null)),
      create: vi.fn(async ({ name, domain }) => {
        wiki = { ...wikiSummary, name, domain }
        upsertWikiItem(wikiItems, wiki, true, false)
        return success(wiki)
      }),
      current: vi.fn(async () => success(wiki)),
      list: vi.fn(async () => success(wikiItems)),
      activate: vi.fn(async ({ wikiId }) => {
        const summary = knownWikis.find(({ id }) => id === wikiId)
        if (summary) {
          wiki = summary
          for (const candidate of wikiItems) {
            candidate.active = candidate.id === wikiId
          }
        }
        return success(wiki ?? wikiSummary)
      }),
      rename: vi.fn(async ({ name }) =>
        success({
          ...(wiki ?? wikiSummary),
          name,
          displayPath: `/research/${name}`,
        })
      ),
      delete: vi.fn(async () => success(wiki)),
    },
    wiki: {
      chooseDocument: vi.fn(async () =>
        success({
          token: "document_1234567890",
          displayName: "write-ahead-logging.pdf",
          suggestedTitle: "write-ahead-logging",
        })
      ),
      registerDocument: vi.fn(async () =>
        success({
          token: "document_1234567890",
          displayName: "write-ahead-logging.pdf",
          suggestedTitle: "write-ahead-logging",
        })
      ),
      startIngest: vi.fn(async () => {
        currentJob = createJob({
          status: "completed",
          phase: "indexing",
          message: "The source is ready to search",
          cancellable: false,
          result: ingestResult(options.index),
        })
        if (wiki) {
          upsertWikiItem(wikiItems, wiki, true, false)
          for (const listener of listeners) {
            listener({ wikiId: wiki.id, job: currentJob })
          }
        }
        return success({ jobId: currentJob.id })
      }),
      currentIngest: vi.fn(async () => success(currentJob)),
      cancelIngest: vi.fn(async () => success(null)),
      refreshIndex: vi.fn(async () => {
        const summary = {
          commitHash: "ingest-commit",
          added: 1,
          updated: 0,
          removed: 0,
          unchanged: 0,
        }
        if (currentJob?.result) {
          currentJob = {
            ...currentJob,
            revision: currentJob.revision + 1,
            result: {
              ...currentJob.result,
              index: { status: "ready", summary },
            },
          }
          if (wiki) {
            for (const listener of listeners) {
              listener({ wikiId: wiki.id, job: currentJob })
            }
          }
        }
        return success(summary)
      }),
      listFiles: vi.fn(async () =>
        success([
          {
            path: "concepts",
            name: "concepts",
            kind: "directory" as const,
            children: [
              {
                path: "concepts/write-ahead-logging.md",
                name: "write-ahead-logging.md",
                kind: "file" as const,
              },
            ],
          },
        ])
      ),
      readFile: vi.fn(async () =>
        success({
          path: "concepts/write-ahead-logging.md",
          name: "write-ahead-logging.md",
          mediaType: "markdown" as const,
          size: 42,
          content: "# Write-ahead logging",
        })
      ),
      search: vi.fn(async () =>
        success([
          {
            kind: "page" as const,
            path: "concepts/write-ahead-logging.md",
            title: "Write-ahead logging",
            pageType: "concept" as const,
            tags: ["storage"],
            snippet: "A WAL preserves ordering for crash recovery.",
            highlights: [{ start: 35, end: 43 }],
            score: 1,
          },
        ])
      ),
      listTags: vi.fn(async () => success([{ tag: "storage", count: 1 }])),
      startUpdate: vi.fn(async () => success({ sessionId: "update_12345678" })),
      continueUpdate: vi.fn(async () => success(null)),
      currentUpdate: vi.fn(async () => success(null)),
      cancelUpdateTurn: vi.fn(async () => success(null)),
      readUpdateDiff: vi.fn(async ({ path }) => success({ path, patch: "" })),
      applyUpdate: vi.fn(async () =>
        success({
          runId: "update_12345678",
          commitHash: "update-commit",
          changedFiles: [],
          summary: "Updated wiki",
          index: {
            status: "ready" as const,
            summary: {
              commitHash: "update-commit",
              added: 0,
              updated: 0,
              removed: 0,
              unchanged: 0,
            },
          },
        })
      ),
      discardUpdate: vi.fn(async () => success(null)),
      onIngestChanged: vi.fn((listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
      onUpdateChanged: vi.fn(() => () => undefined),
    },
    emitOAuthEvent: (event) => {
      for (const listener of piListeners) listener(event)
    },
  }
  return api
}

const wikiSummary: WikiSummary = {
  id: "wiki-id",
  name: "Reliability Wiki",
  domain: "Database reliability engineering",
  displayPath: "/research/Reliability Wiki",
  commitHash: "initial-commit",
  setupStatus: "initialized",
}

const secondWikiSummary: WikiSummary = {
  id: "second-wiki-id",
  name: "Second Wiki",
  domain: "Compiler research",
  displayPath: "/research/Second Wiki",
  commitHash: "second-commit",
  setupStatus: "ready",
}

function ingestResult(
  index: IngestPastedSourceResult["index"] = {
    status: "ready",
    summary: {
      commitHash: "ingest-commit",
      added: 1,
      updated: 0,
      removed: 0,
      unchanged: 0,
    },
  }
): IngestPastedSourceResult {
  return {
    runId: "run-id",
    commitHash: "ingest-commit",
    changedFiles: ["concepts/write-ahead-logging.md"],
    summary: "Added write-ahead logging.",
    index,
  }
}

function createJob(
  state: Pick<WikiIngestJob, "status" | "phase" | "message" | "cancellable"> & {
    result?: IngestPastedSourceResult
  }
): WikiIngestJob {
  return {
    id: "ingest_job-1234567890",
    title: "Write-ahead logging",
    startedAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:01.000Z",
    revision: 3,
    ...state,
  }
}

async function createWiki(
  user: ReturnType<typeof userEvent.setup>
): Promise<void> {
  await screen.findByRole("heading", { name: "Start a new wiki" })
  await user.click(screen.getByRole("button", { name: "Wiki home" }))
  await screen.findAllByText("/research")
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error("Expected the document file input")
  await user.upload(
    input,
    new File(["source"], "write-ahead-logging.pdf", {
      type: "application/pdf",
    })
  )
  await screen.findByText("write-ahead-logging.pdf")
  const wikiName = screen.getByLabelText("Wiki name")
  if (!(wikiName instanceof HTMLInputElement)) {
    throw new Error("Expected the wiki name input")
  }
  expect(wikiName.value).toBe("write-ahead-logging")
  await user.clear(wikiName)
  await user.type(wikiName, "Reliability Wiki")
  await user.type(
    screen.getByLabelText("What should Amend focus on? (optional)"),
    "Recovery ordering and replication tradeoffs"
  )
  await user.click(screen.getByRole("button", { name: "Build wiki" }))
}

function success<T>(value: T): AmendResult<T> {
  return { ok: true, value }
}

function listItem(
  wiki: WikiSummary,
  active: boolean,
  running: boolean
): WikiListItem {
  return {
    id: wiki.id,
    name: wiki.name,
    displayPath: wiki.displayPath,
    active,
    running,
  }
}

function upsertWikiItem(
  items: WikiListItem[],
  wiki: WikiSummary,
  active: boolean,
  running: boolean
): void {
  const item = listItem(wiki, active, running)
  const index = items.findIndex(({ id }) => id === wiki.id)
  if (index === -1) items.push(item)
  else items[index] = item
}
