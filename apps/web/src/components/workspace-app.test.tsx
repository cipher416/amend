// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient } from "@tanstack/react-query"
import type {
  AmendApi,
  AmendResult,
  ReadWikiFileInput,
  WikiFileContent,
  WikiIngestChangedEvent,
  WikiFileTreeItem,
  WorkspaceSummary,
} from "@workspace/contract"
import { useState } from "react"
import type { ButtonHTMLAttributes, ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  WorkspaceApp,
  WorkspaceEmptyContent,
  WorkspaceFileContent,
} from "./workspace-app"

const routeHarness = vi.hoisted(() => ({
  workspaceId: undefined as string | undefined,
  filePath: undefined as string | undefined,
  queryClient: undefined as QueryClient | undefined,
  renderOutlet: undefined as undefined | (() => ReactNode),
  navigate: undefined as
    | undefined
    | ((workspaceId: string, filePath?: string) => void),
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
  useRouterState: <T,>({
    select,
  }: {
    select: (state: {
      matches: Array<{ params: { workspaceId?: string; _splat?: string } }>
    }) => T
  }) =>
    select({
      matches: [
        {
          params: {
            workspaceId: routeHarness.workspaceId,
            _splat: routeHarness.filePath,
          },
        },
      ],
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

beforeEach(() => {
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
  it("renders the workspace file tree and previews selected files", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()
    window.amend = api

    renderWorkspaceApp(api, {
      initialWorkspaceId: workspaceSummary.id,
      initialFilePath: "concepts/write-ahead-logging.md",
    })

    await screen.findByRole("link", { name: "write-ahead-logging.md" })
    await screen.findByText("# Write-ahead logging")
    await user.click(screen.getByRole("link", { name: "paper.pdf" }))

    await screen.findByText("Preview unavailable")
    expect(api.wiki.listFiles).toHaveBeenCalledOnce()
    expect(api.wiki.readFile).toHaveBeenCalledWith({
      path: "concepts/write-ahead-logging.md",
    })
    expect(api.wiki.readFile).toHaveBeenCalledWith({ path: "paper.pdf" })
  })

  it("keeps workspace running badges fresh from ingest events", async () => {
    const api = createDesktopApi()
    window.amend = api

    renderWorkspaceApp(api, {
      initialWorkspaceId: workspaceSummary.id,
      initialFilePath: "concepts/write-ahead-logging.md",
    })

    await screen.findByRole("option", { name: "Archive Wiki - running" })
    await act(() => {
      api.emitIngestChanged({
        workspaceId: archiveWorkspaceSummary.id,
        job: {
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
        },
      })
    })

    expect(screen.getByRole("option", { name: "Archive Wiki" })).toBeDefined()
    expect(
      screen.queryByRole("option", { name: "Archive Wiki - running" })
    ).toBeNull()
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
      filePath ? <WorkspaceFileContent /> : <WorkspaceEmptyContent />
    return <WorkspaceApp />
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

function createDesktopApi(): MockAmendApi {
  const ingestListeners = new Set<(event: WikiIngestChangedEvent) => void>()
  const api: MockAmendApi = {
    runtime: "electron",
    platform: "linux",
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
            running: false,
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
            : {
              path,
              name: "write-ahead-logging.md",
              mediaType: "markdown",
              size: 21,
              content: "# Write-ahead logging",
            }
        return success(file)
      }),
      search: vi.fn(async () => success([])),
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

function success<T>(value: T): AmendResult<T> {
  return { ok: true, value }
}
