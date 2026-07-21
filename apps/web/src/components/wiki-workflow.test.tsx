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
  WorkspaceListItem,
  WorkspaceSummary,
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

beforeEach(() => {
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
  it("creates a workspace and builds a wiki from its first document", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()
    window.amend = api
    render(<WikiWorkflow />)

    await createWiki(user)

    await screen.findByText("Wiki ready")
    expect(api.workspaces.create).toHaveBeenCalledWith({
      selectionToken: "selection_1234567890",
      name: "Reliability Wiki",
      domain: "Database reliability engineering",
    })
    expect(api.wiki.startIngest).toHaveBeenCalledWith({
      documentToken: "document_1234567890",
      objective: "Capture recovery ordering",
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
      workspace: workspaceSummary,
      job: createJob({
        status: "running",
        phase: "writing",
        message: "Writing and linking wiki pages",
        cancellable: true,
      }),
    })
    window.amend = api
    render(<WikiWorkflow />)

    await screen.findByText("Writing and linking wiki pages")
    expect(screen.getByText("Building your wiki")).toBeDefined()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined()
    expect(api.workspaces.current).toHaveBeenCalledOnce()
    expect(api.wiki.currentIngest).toHaveBeenCalledOnce()
  })

  it("restores a completed workspace without returning to source setup", async () => {
    const api = createDesktopApi({
      workspace: { ...workspaceSummary, setupStatus: "ready" },
    })
    window.amend = api
    render(<WikiWorkflow />)

    await screen.findByText("Wiki ready")
    expect(screen.getByText("Your existing wiki is ready to browse.")).toBeDefined()
    expect(screen.queryByText("Create a knowledge base")).toBeNull()
  })

  it("explains that the browser scaffold cannot access local wiki data", async () => {
    render(<WikiWorkflow />)

    await screen.findByText("Your wiki lives on your machine.")
  })

  it("opens an existing workspace without creating a new one", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()
    window.amend = api
    render(<WikiWorkflow />)

    await screen.findByText("Create a knowledge base")
    await user.click(
      screen.getByRole("button", { name: "Open existing workspace" })
    )

    expect(api.workspaces.open).toHaveBeenCalledOnce()
    await screen.findByLabelText("Workspace name")
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error("Expected the document file input")
    await user.upload(
      input,
      new File(["source"], "write-ahead-logging.pdf", {
        type: "application/pdf",
      })
    )
    await user.type(
      screen.getByLabelText("What matters?"),
      "Capture recovery ordering"
    )
    await user.click(screen.getByRole("button", { name: "Build wiki" }))

    await screen.findByText("Wiki ready")
    expect(api.workspaces.create).not.toHaveBeenCalled()
  })

  it("switches between known workspaces in the app shell", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi({
      workspace: { ...workspaceSummary, setupStatus: "ready" },
      knownWorkspaces: [
        { ...workspaceSummary, setupStatus: "ready" },
        secondWorkspaceSummary,
      ],
    })
    window.amend = api
    render(<WikiWorkflow />)

    await screen.findByText("Wiki ready")
    const switcher = await screen.findByLabelText("Workspace")
    await user.selectOptions(switcher, secondWorkspaceSummary.id)

    expect(api.workspaces.activate).toHaveBeenCalledWith({
      workspaceId: secondWorkspaceSummary.id,
    })
    await screen.findByText(secondWorkspaceSummary.displayPath)
  })

  it("does not show an old ingest after opening another workspace", async () => {
    const user = userEvent.setup()
    const runningJob = createJob({
      status: "running",
      phase: "writing",
      message: "Writing the first wiki",
      cancellable: true,
    })
    const api = createDesktopApi({
      workspace: { ...workspaceSummary, setupStatus: "ready" },
      job: runningJob,
      knownWorkspaces: [
        { ...workspaceSummary, setupStatus: "ready" },
        secondWorkspaceSummary,
      ],
    })
    let opened = false
    api.workspaces.open = vi.fn(async () => {
      opened = true
      return success(secondWorkspaceSummary)
    })
    api.wiki.currentIngest = vi.fn(async () => success(opened ? null : runningJob))
    window.amend = api
    render(<WikiWorkflow />)

    await screen.findByText("Writing the first wiki")
    await user.click(screen.getByRole("button", { name: "Open workspace" }))

    await screen.findByText("Wiki ready")
    expect(screen.queryByText("Writing the first wiki")).toBeNull()
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
    expect(screen.queryByText("Create a knowledge base")).toBeNull()

    await user.click(
      screen.getByRole("button", { name: "Or connect with an API key" })
    )
    await screen.findByLabelText("Provider")
    await user.selectOptions(screen.getByLabelText("Provider"), "zai")
    await user.type(screen.getByLabelText("API key"), "sk-test-key")
    await user.click(screen.getByRole("button", { name: "Save and continue" }))

    await screen.findByLabelText("Default model")
    expect(api.providers.connectWithApiKey).toHaveBeenCalledWith({
      provider: "zai",
      apiKey: "sk-test-key",
    })

    await user.selectOptions(
      screen.getByLabelText("Default model"),
      "glm-5-turbo"
    )
    await user.click(screen.getByRole("button", { name: "Continue" }))

    expect(api.providers.setDefaultModel).toHaveBeenCalledWith({
      provider: "zai",
      model: "glm-5-turbo",
    })
    await screen.findByText("Create a knowledge base")
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
    workspace?: WorkspaceSummary
    job?: WikiIngestJob
    index?: IngestPastedSourceResult["index"]
    piConfigured?: boolean
    knownWorkspaces?: readonly WorkspaceSummary[]
  } = {}
): MockAmendApi {
  let workspace = options.workspace ?? null
  let currentJob = options.job ?? null
  const knownWorkspaces = [...(options.knownWorkspaces ?? [])]
  if (workspace && !knownWorkspaces.some(({ id }) => id === workspace?.id)) {
    knownWorkspaces.push(workspace)
  }
  const workspaceItems: WorkspaceListItem[] = knownWorkspaces.map((candidate) =>
    listItem(
      candidate,
      candidate.id === workspace?.id,
      candidate.id === workspace?.id && currentJob?.status === "running"
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
    workspaces: {
      chooseLocation: vi.fn(async () =>
        success({
          token: "selection_1234567890",
          displayPath: "/research",
        })
      ),
      create: vi.fn(async () => {
        workspace = workspaceSummary
        upsertWorkspaceItem(workspaceItems, workspace, true, false)
        return success(workspaceSummary)
      }),
      open: vi.fn(async () => {
        workspace = workspaceSummary
        upsertWorkspaceItem(workspaceItems, workspace, true, false)
        return success(workspaceSummary)
      }),
      current: vi.fn(async () => success(workspace)),
      list: vi.fn(async () => success(workspaceItems)),
      activate: vi.fn(async ({ workspaceId }) => {
        const summary = knownWorkspaces.find(({ id }) => id === workspaceId)
        if (summary) {
          workspace = summary
          for (const candidate of workspaceItems) {
            candidate.active = candidate.id === workspaceId
          }
        }
        return success(workspace ?? workspaceSummary)
      }),
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
        if (workspace) {
          upsertWorkspaceItem(workspaceItems, workspace, true, false)
          for (const listener of listeners) {
            listener({ workspaceId: workspace.id, job: currentJob })
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
          if (workspace) {
            for (const listener of listeners) {
              listener({ workspaceId: workspace.id, job: currentJob })
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
      onIngestChanged: vi.fn((listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
    },
    emitOAuthEvent: (event) => {
      for (const listener of piListeners) listener(event)
    },
  }
  return api
}

const workspaceSummary: WorkspaceSummary = {
  id: "workspace-id",
  name: "Reliability Wiki",
  domain: "Database reliability engineering",
  displayPath: "/research/Reliability Wiki",
  commitHash: "initial-commit",
  setupStatus: "initialized",
}

const secondWorkspaceSummary: WorkspaceSummary = {
  id: "second-workspace-id",
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
  await screen.findByText("Create a knowledge base")
  await user.type(screen.getByLabelText("Workspace name"), "Reliability Wiki")
  await user.type(
    screen.getByLabelText("Domain"),
    "Database reliability engineering"
  )
  await user.click(screen.getByRole("button", { name: "Parent location" }))
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
  await user.type(
    screen.getByLabelText("What matters?"),
    "Capture recovery ordering"
  )
  await user.click(screen.getByRole("button", { name: "Create wiki" }))
}

function success<T>(value: T): AmendResult<T> {
  return { ok: true, value }
}

function listItem(
  workspace: WorkspaceSummary,
  active: boolean,
  running: boolean
): WorkspaceListItem {
  return {
    id: workspace.id,
    name: workspace.name,
    displayPath: workspace.displayPath,
    active,
    running,
  }
}

function upsertWorkspaceItem(
  items: WorkspaceListItem[],
  workspace: WorkspaceSummary,
  active: boolean,
  running: boolean
): void {
  const item = listItem(workspace, active, running)
  const index = items.findIndex(({ id }) => id === workspace.id)
  if (index === -1) items.push(item)
  else items[index] = item
}
