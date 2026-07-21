// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient } from "@tanstack/react-query"
import type {
  AmendApi,
  AmendResult,
  ReadWikiFileInput,
  WikiFileContent,
  WikiIngestChangedEvent,
  WikiIngestJob,
  WikiFileTreeItem,
  WikiSearchResult,
  WorkspaceSummary,
} from "@workspace/contract"
import { useState } from "react"
import type { ButtonHTMLAttributes, ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  WorkspaceApp,
  WorkspaceFileContent,
} from "./workspace-app"

const routeHarness = vi.hoisted(() => ({
  workspaceId: undefined as string | undefined,
  filePath: undefined as string | undefined,
  queryClient: undefined as QueryClient | undefined,
  renderOutlet: undefined as undefined | (() => ReactNode),
  navigate: undefined as
    undefined | ((workspaceId: string, filePath?: string) => void),
}))

interface MockRouteParams {
  workspaceId?: string
  _splat?: string
}

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => routeHarness.renderOutlet?.() ?? null,
  Link: ({
    params,
    children,
  }: {
    params: MockRouteParams
    children: ReactNode
  }) => (
    <a
      href="#"
      onClick={(event) => {
        event.preventDefault()
        if (params.workspaceId) {
          routeHarness.navigate?.(params.workspaceId, params._splat)
        }
      }}
    >
      {children}
    </a>
  ),
  useNavigate:
    () =>
    ({ params }: { params: MockRouteParams }) => {
      if (params.workspaceId) {
        routeHarness.navigate?.(params.workspaceId, params._splat)
      }
    },
  useRouter: () => ({
    options: {
      context: {
        queryClient: routeHarness.queryClient,
      },
    },
  }),
  useParams: () => ({
    workspaceId: routeHarness.workspaceId,
    _splat: routeHarness.filePath,
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

vi.mock("@workspace/ui/components/dropdown-menu", async () => {
  const React = await import("react")
  const menuGroupContext = React.createContext(false)
  const MenuGroupProvider = menuGroupContext.Provider

  return {
    DropdownMenu: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuTrigger: ({
      render: _render,
      children,
      ...props
    }: ButtonHTMLAttributes<HTMLButtonElement> & {
      render?: ReactNode
    }) => <button {...props}>{children}</button>,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    DropdownMenuLabel: ({ children }: { children: ReactNode }) => {
      if (!React.useContext(menuGroupContext)) {
        throw new Error("Menu group parts must be used within a radio group.")
      }
      return <span>{children}</span>
    },
    DropdownMenuItem: ({
      children,
      ...props
    }: ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
    DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => (
      <MenuGroupProvider value>
        <div>{children}</div>
      </MenuGroupProvider>
    ),
    DropdownMenuRadioItem: ({
      children,
    }: {
      children: ReactNode
      value: string
    }) => <button role="menuitemradio">{children}</button>,
    DropdownMenuSeparator: () => <hr />,
  }
})

vi.mock("@workspace/ui/components/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
  SheetDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  SheetFooter: ({ children }: { children: ReactNode }) => (
    <footer>{children}</footer>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

vi.mock("@workspace/ui/components/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
    observe(_target: Element) {}
    unobserve(_target: Element) {}
    disconnect() {}
  }
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  delete window.amend
  routeHarness.workspaceId = undefined
  routeHarness.filePath = undefined
  routeHarness.queryClient = undefined
  routeHarness.renderOutlet = undefined
  routeHarness.navigate = undefined
})

describe("workspace app", () => {
  it("opens index.md at the workspace root", async () => {
    const api = createDesktopApi()
    window.amend = api

    renderWorkspaceApp(api, { initialWorkspaceId: workspaceSummary.id })

    await screen.findByRole("heading", { name: "Reliability Wiki" })
    expect(api.wiki.readFile).toHaveBeenCalledWith({ path: "index.md" })
  })

  it("renders the workspace file tree and previews selected files", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()
    window.amend = api

    renderWorkspaceApp(api, {
      initialWorkspaceId: workspaceSummary.id,
      initialFilePath: "concepts/write-ahead-logging.md",
    })

    await screen.findByRole("link", { name: "write-ahead-logging.md" })
    await screen.findByRole("heading", { name: "Write-ahead logging" })
    await screen.findByText("Created 2026-07-20")
    await screen.findByText("storage")
    await screen.findByRole("link", { name: "raw/papers/paper.md" })
    expect(screen.queryByText("title: Write-Ahead Logging")).toBeNull()
    await user.click(screen.getByRole("link", { name: "paper.pdf" }))

    await screen.findByText("Preview unavailable")
    expect(api.wiki.listFiles).toHaveBeenCalledOnce()
    expect(api.wiki.readFile).toHaveBeenCalledWith({
      path: "concepts/write-ahead-logging.md",
    })
    expect(api.wiki.readFile).toHaveBeenCalledWith({ path: "paper.pdf" })
  })

  it("opens an existing workspace from the workspace picker", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()
    window.amend = api

    renderWorkspaceApp(api, { initialWorkspaceId: workspaceSummary.id })

    await user.click(
      await screen.findByRole("button", { name: "Open workspace" })
    )

    await waitFor(() => expect(api.workspaces.open).toHaveBeenCalledOnce())
  })

  it("adds a document with editable workspace guidance", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()
    const source = new File(["source"], "incident-review.md", {
      type: "text/markdown",
    })
    window.amend = api

    renderWorkspaceApp(api, { initialWorkspaceId: workspaceSummary.id })

    await user.click(
      await screen.findByRole("button", { name: "Add document" })
    )
    const objective = await screen.findByLabelText("What matters?")
    expect((objective as HTMLTextAreaElement).value).toBe(
      "Capture concepts, evidence, and tradeoffs relevant to Database reliability engineering."
    )
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error("Expected the document file input")
    await user.upload(input, source)

    await waitFor(() =>
      expect(api.wiki.registerDocument).toHaveBeenCalledWith(source)
    )
    await user.clear(objective)
    await user.type(objective, "Preserve incident response decisions")
    await user.click(screen.getByRole("button", { name: "Add to wiki" }))

    await waitFor(() =>
      expect(api.wiki.startIngest).toHaveBeenCalledWith({
        documentToken: "document_1234567890",
        objective: "Preserve incident response decisions",
      })
    )
    expect(screen.queryByRole("heading", { name: "Add document" })).toBeNull()
  })

  it("disables adding a document while the active workspace is ingesting", async () => {
    const api = createDesktopApi({ activeWorkspaceRunning: true })
    window.amend = api

    renderWorkspaceApp(api, { initialWorkspaceId: workspaceSummary.id })

    expect(
      await screen.findByRole("button", { name: "Add document" })
    ).toHaveProperty("disabled", true)
  })

  it("navigates wikilinks inside Markdown and opens external links separately", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()
    window.amend = api

    renderWorkspaceApp(api, {
      initialWorkspaceId: workspaceSummary.id,
      initialFilePath: "concepts/write-ahead-logging.md",
    })

    const wikiLink = await screen.findByRole("link", { name: "checkpointing" })
    expect(wikiLink.getAttribute("href")).toBe(
      "/workspace/workspace-id/concepts/checkpointing.md"
    )
    expect(screen.getByRole("link", { name: "Reference" })).toHaveProperty(
      "target",
      "_blank"
    )

    await user.click(screen.getByRole("button", { name: "concepts" }))
    expect(screen.queryByRole("link", { name: "checkpointing.md" })).toBeNull()

    await user.click(wikiLink)

    await screen.findByRole("heading", { name: "Checkpointing" })
    await screen.findByRole("link", { name: "checkpointing.md" })
    expect(api.wiki.readFile).toHaveBeenCalledWith({
      path: "concepts/checkpointing.md",
    })
  })

  it("expands and collapses workspace folders", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()
    window.amend = api

    renderWorkspaceApp(api, { initialWorkspaceId: workspaceSummary.id })

    const folder = await screen.findByRole("button", { name: "concepts" })
    expect(
      screen.queryByRole("link", { name: "write-ahead-logging.md" })
    ).toBeNull()

    await user.click(folder)
    await screen.findByRole("link", { name: "write-ahead-logging.md" })

    await user.click(folder)
    expect(
      screen.queryByRole("link", { name: "write-ahead-logging.md" })
    ).toBeNull()
  })

  it("searches the wiki and opens the selected result", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi({
      searchResults: [
        {
          kind: "page",
          path: "concepts/checkpointing.md",
          title: "Checkpointing",
          pageType: "concept",
          tags: ["storage"],
          snippet: "A checkpoint records durable state.",
          highlights: [],
          score: 0.9,
        },
      ],
    })
    window.amend = api

    renderWorkspaceApp(api, { initialWorkspaceId: workspaceSummary.id })

    await user.click(await screen.findByRole("button", { name: /search wiki/i }))
    await user.type(
      await screen.findByPlaceholderText("Search this wiki..."),
      "checkpointing"
    )

    await screen.findByText("Checkpointing")
    expect(api.wiki.search).toHaveBeenCalledWith({
      query: "checkpointing",
      limit: 20,
    })

    await user.click(screen.getByText("Checkpointing"))
    await screen.findByRole("heading", { name: "Checkpointing" })
    expect(api.wiki.readFile).toHaveBeenCalledWith({
      path: "concepts/checkpointing.md",
    })
  })

  it("toggles wiki search with Ctrl+K", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()
    window.amend = api

    renderWorkspaceApp(api, { initialWorkspaceId: workspaceSummary.id })

    await user.keyboard("{Control>}k{/Control}")
    await screen.findByPlaceholderText("Search this wiki...")

    await user.keyboard("{Control>}k{/Control}")
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search this wiki...")).toBeNull()
    )
  })

  it("finds text within the open file with Ctrl+F", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()
    window.amend = api

    renderWorkspaceApp(api, { initialWorkspaceId: workspaceSummary.id })

    await screen.findByRole("heading", { name: "Reliability Wiki" })
    await user.keyboard("{Control>}f{/Control}")
    const findInput = await screen.findByPlaceholderText("Find in this file")
    await user.type(findInput, "Welcome")
    await screen.findByText("1/2")

    await user.keyboard("{ArrowDown}")
    await screen.findByText("2/2")

    await user.keyboard("{ArrowUp}")
    await screen.findByText("1/2")

    await user.click(screen.getByRole("button", { name: "Close find in file" }))
    expect(screen.queryByPlaceholderText("Find in this file")).toBeNull()
  })

  it("keeps workspace running badges fresh from ingest events", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()
    window.amend = api

    renderWorkspaceApp(api, {
      initialWorkspaceId: workspaceSummary.id,
      initialFilePath: "concepts/write-ahead-logging.md",
    })

    await user.click(
      await screen.findByRole("button", { name: "Reliability Wiki" })
    )
    const archiveWorkspace = (await screen.findAllByRole("menuitemradio"))[1]
    expect(archiveWorkspace.textContent).toContain("Running")
    await waitFor(() => expect(api.wiki.onIngestChanged).toHaveBeenCalledOnce())
    await act(() => {
      api.emitIngestChanged({
        workspaceId: archiveWorkspaceSummary.id,
        job: completedIngestJob,
      })
    })

    await waitFor(() =>
      expect(screen.getAllByRole("menuitemradio")[1].textContent).not.toContain(
        "Running"
      )
    )
  })

  it("refreshes active workspace files after an ingest completes", async () => {
    const api = createDesktopApi()
    window.amend = api

    renderWorkspaceApp(api, { initialWorkspaceId: workspaceSummary.id })

    await screen.findByRole("button", { name: "Add document" })
    await waitFor(() => expect(api.wiki.listFiles).toHaveBeenCalledOnce())
    await act(() => {
      api.emitIngestChanged({
        workspaceId: workspaceSummary.id,
        job: completedIngestJob,
      })
    })

    await waitFor(() => expect(api.wiki.listFiles).toHaveBeenCalledTimes(2))
  })

  it("does not read a file when the route workspace cannot be activated", async () => {
    const api = createDesktopApi()
    vi.mocked(api.workspaces.activate).mockResolvedValue({
      ok: false,
      error: {
        code: "workspace-open-failed",
        message: "Workspace unavailable",
      },
    })

    renderWorkspaceApp(api, {
      initialWorkspaceId: "unavailable-workspace",
      initialFilePath: "concepts/write-ahead-logging.md",
    })

    await waitFor(() =>
      expect(api.workspaces.activate).toHaveBeenCalledWith({
        workspaceId: "unavailable-workspace",
      })
    )
    expect(api.wiki.readFile).not.toHaveBeenCalled()
  })
})

function renderWorkspaceApp(
  api: MockAmendApi,
  {
    initialWorkspaceId,
    initialFilePath,
  }: {
    initialWorkspaceId?: string
    initialFilePath?: string
  } = {}
) {
  window.amend = api

  function WorkspaceRouteHarness() {
    const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId)
    const [filePath, setFilePath] = useState(initialFilePath)
    routeHarness.workspaceId = workspaceId
    routeHarness.filePath = filePath
    routeHarness.navigate = (nextWorkspaceId, nextFilePath) => {
      setWorkspaceId(nextWorkspaceId)
      setFilePath(nextFilePath)
    }
    routeHarness.renderOutlet = () =>
      filePath ? (
        <WorkspaceFileContent
          workspaceId={workspaceId ?? workspaceSummary.id}
          filePath={filePath}
        />
      ) : (
        <WorkspaceFileContent
          workspaceId={workspaceId ?? workspaceSummary.id}
          filePath="index.md"
        />
      )
    return <WorkspaceApp workspaceId={workspaceId ?? workspaceSummary.id} />
  }

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  routeHarness.queryClient = queryClient

  return render(<WorkspaceRouteHarness />)
}

type MockAmendApi = AmendApi & {
  emitIngestChanged: (event: WikiIngestChangedEvent) => void
}

function createDesktopApi({
  activeWorkspaceRunning = false,
  searchResults = [],
}: {
  activeWorkspaceRunning?: boolean
  searchResults?: readonly WikiSearchResult[]
} = {}): MockAmendApi {
  const ingestListeners = new Set<(event: WikiIngestChangedEvent) => void>()
  const api: MockAmendApi = {
    runtime: "electron",
    platform: "linux",
    appearance: {
      setTheme: vi.fn(async () => success(null)),
    },
    workspaces: {
      chooseLocation: vi.fn(async () => success(null)),
      create: vi.fn(async () => success(workspaceSummary)),
      open: vi.fn(async () => success(workspaceSummary)),
      current: vi.fn(async () => success(workspaceSummary)),
      list: vi.fn(async () =>
        success([
          {
            id: workspaceSummary.id,
            name: workspaceSummary.name,
            displayPath: workspaceSummary.displayPath,
            active: true,
            running: activeWorkspaceRunning,
          },
          {
            id: archiveWorkspaceSummary.id,
            name: archiveWorkspaceSummary.name,
            displayPath: archiveWorkspaceSummary.displayPath,
            active: false,
            running: true,
          },
        ])
      ),
      activate: vi.fn(async () => success(workspaceSummary)),
    },
    providers: {
      status: vi.fn(async () => success({ configured: true })),
      list: vi.fn(async () => success([])),
      listModels: vi.fn(async () => success([])),
      startOAuth: vi.fn(async () => success({ loginId: "login-id" })),
      respondToOAuthPrompt: vi.fn(async () => success(null)),
      cancelOAuth: vi.fn(async () => success(null)),
      connectWithApiKey: vi.fn(async () => success(null)),
      setDefaultModel: vi.fn(async () => success(null)),
      onOAuthEvent: vi.fn(() => () => undefined),
    },
    wiki: {
      chooseDocument: vi.fn(async () => success(null)),
      registerDocument: vi.fn(async () =>
        success({
          token: "document_1234567890",
          displayName: "paper.pdf",
          suggestedTitle: "paper",
        })
      ),
      startIngest: vi.fn(async () => success({ jobId: "ingest_1234567890" })),
      currentIngest: vi.fn(async () => success(null)),
      cancelIngest: vi.fn(async () => success(null)),
      refreshIndex: vi.fn(async () =>
        success({
          commitHash: "commit",
          added: 0,
          updated: 0,
          removed: 0,
          unchanged: 0,
        })
      ),
      listFiles: vi.fn(async () => {
        const files: readonly WikiFileTreeItem[] = [
          { path: "index.md", name: "index.md", kind: "file" },
          {
            path: "concepts",
            name: "concepts",
            kind: "directory",
            children: [
              {
                path: "concepts/write-ahead-logging.md",
                name: "write-ahead-logging.md",
                kind: "file",
              },
              {
                path: "concepts/checkpointing.md",
                name: "checkpointing.md",
                kind: "file",
              },
            ],
          },
          { path: "paper.pdf", name: "paper.pdf", kind: "file" },
        ]
        return success(files)
      }),
      readFile: vi.fn(async ({ path }: ReadWikiFileInput) => {
        const file: WikiFileContent =
          path === "paper.pdf"
            ? {
                path,
                name: "paper.pdf",
                mediaType: "binary",
                size: 9,
              }
            : path === "index.md"
              ? {
                  path,
                  name: "index.md",
                  mediaType: "markdown",
                  size: 31,
                  content: "# Reliability Wiki\n\nWelcome. Welcome.",
                }
              : path === "concepts/checkpointing.md"
              ? {
                  path,
                  name: "checkpointing.md",
                  mediaType: "markdown",
                  size: 17,
                  content: "# Checkpointing",
                }
              : {
                  path,
                  name: "write-ahead-logging.md",
                  mediaType: "markdown",
                  size: 190,
                  content:
                    "---\ntitle: Write-Ahead Logging\ncreated: 2026-07-20\nupdated: 2026-07-20\ntype: concept\ntags:\n  - storage\nsources:\n  - raw/papers/paper.md\n---\n\n# Write-ahead logging\n\nSee [[checkpointing]].\n\n[Reference](https://example.com/workspace/other/page).",
                }
        return success(file)
      }),
      search: vi.fn(async () => success(searchResults)),
      listTags: vi.fn(async () => success([])),
      onIngestChanged: vi.fn((listener) => {
        ingestListeners.add(listener)
        return () => ingestListeners.delete(listener)
      }),
    },
    emitIngestChanged: (event) => {
      for (const listener of ingestListeners) listener(event)
    },
  }
  return api
}

const workspaceSummary: WorkspaceSummary = {
  id: "workspace-id",
  name: "Reliability Wiki",
  domain: "Database reliability engineering",
  displayPath: "/research/Reliability Wiki",
  commitHash: "commit",
  setupStatus: "ready",
}

const archiveWorkspaceSummary: WorkspaceSummary = {
  id: "archive-workspace-id",
  name: "Archive Wiki",
  domain: "Archive research",
  displayPath: "/research/Archive Wiki",
  commitHash: "commit",
  setupStatus: "ready",
}

const completedIngestJob: WikiIngestJob = {
  id: "ingest_1234567890",
  title: "Paper",
  status: "completed",
  phase: "indexing",
  message: "Done",
  startedAt: "2026-07-20T12:00:00.000Z",
  updatedAt: "2026-07-20T12:00:01.000Z",
  revision: 2,
  cancellable: false,
  result: {
    runId: "run-id",
    commitHash: "commit",
    changedFiles: ["concepts/paper.md"],
    summary: "Done",
    index: {
      status: "ready",
      summary: {
        commitHash: "commit",
        added: 1,
        updated: 0,
        removed: 0,
        unchanged: 0,
      },
    },
  },
}

function success<T>(value: T): AmendResult<T> {
  return { ok: true, value }
}
