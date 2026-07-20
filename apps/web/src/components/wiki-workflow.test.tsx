// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type {
  AmendApi,
  AmendResult,
  IngestPastedSourceResult,
  PiLoginEvent,
  WikiIngestJob,
  WorkspaceSummary,
} from "@workspace/contract"
import type { ButtonHTMLAttributes } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { WikiWorkflow } from "./wiki-workflow"

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

afterEach(() => {
  cleanup()
  delete window.amend
})

describe("first source workflow", () => {
  it("creates a workspace and builds a wiki from its first document", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()
    window.amend = api
    render(<WikiWorkflow />)

    await createWiki(user)

    await screen.findByText("Wiki ready")
    expect(api.workspace.create).toHaveBeenCalledWith({
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
    expect(api.workspace.current).toHaveBeenCalledOnce()
    expect(api.wiki.currentIngest).toHaveBeenCalledOnce()
  })

  it("explains that the browser scaffold cannot access local wiki data", async () => {
    render(<WikiWorkflow />)

    await screen.findByText("Your wiki lives on your machine.")
  })
})

describe("Pi connection gate", () => {
  it("blocks onboarding until a model provider is connected", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi({ piConfigured: false })
    api.pi.listApiKeyProviders = vi.fn(async () =>
      success([{ id: "zai", name: "ZAI Coding Plan (Global)" }])
    )
    api.pi.listModels = vi.fn(async () =>
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
    expect(api.pi.saveApiKeyCredential).toHaveBeenCalledWith({
      provider: "zai",
      apiKey: "sk-test-key",
    })

    await user.selectOptions(
      screen.getByLabelText("Default model"),
      "glm-5-turbo"
    )
    await user.click(screen.getByRole("button", { name: "Continue" }))

    expect(api.pi.setDefaultModel).toHaveBeenCalledWith({
      provider: "zai",
      model: "glm-5-turbo",
    })
    await screen.findByText("Create a knowledge base")
  })
})

function createDesktopApi(
  options: {
    workspace?: WorkspaceSummary
    job?: WikiIngestJob
    index?: IngestPastedSourceResult["index"]
    piConfigured?: boolean
  } = {}
): AmendApi {
  let workspace = options.workspace ?? null
  let currentJob = options.job ?? null
  const listeners = new Set<(job: WikiIngestJob) => void>()
  const piListeners = new Set<(event: PiLoginEvent) => void>()
  const api: AmendApi = {
    runtime: "electron",
    platform: "linux",
    pi: {
      status: vi.fn(async () =>
        success({ configured: options.piConfigured ?? true })
      ),
      listApiKeyProviders: vi.fn(async () => success([])),
      listModels: vi.fn(async () => success([])),
      startOAuthLogin: vi.fn(async () => success({ loginId: "login-id" })),
      respondToPrompt: vi.fn(async () => success(null)),
      cancelLogin: vi.fn(async () => success(null)),
      saveApiKeyCredential: vi.fn(async () => success(null)),
      setDefaultModel: vi.fn(async () => success(null)),
      onLoginEvent: vi.fn((listener) => {
        piListeners.add(listener)
        return () => piListeners.delete(listener)
      }),
    },
    workspace: {
      chooseParent: vi.fn(async () =>
        success({
          token: "selection_1234567890",
          displayPath: "/research",
        })
      ),
      create: vi.fn(async () => {
        workspace = workspaceSummary
        return success(workspaceSummary)
      }),
      current: vi.fn(async () => success(workspace)),
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
        for (const listener of listeners) listener(currentJob)
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
          for (const listener of listeners) listener(currentJob)
        }
        return success(summary)
      }),
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
  }
  return api
}

const workspaceSummary: WorkspaceSummary = {
  id: "workspace-id",
  name: "Reliability Wiki",
  domain: "Database reliability engineering",
  displayPath: "/research/Reliability Wiki",
  commitHash: "initial-commit",
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
