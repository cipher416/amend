import { describe, expect, it } from "vitest"

import {
  isCreateWorkspaceInput,
  isCancelIngestInput,
  isIngestDocumentInput,
  isPiCancelLoginInput,
  isPiListModelsInput,
  isPiRespondToPromptInput,
  isPiSaveApiKeyInput,
  isPiSetDefaultModelInput,
  isStartPiOAuthLoginInput,
  isWikiSearchInput,
} from "./index.ts"
import {
  isAmendResult,
  isPiConnectionStatus,
  isPiLoginEvent,
  isPiModelSummaries,
  isPiProviderSummaries,
  isSourceDocumentSelectionOrNull,
  isStartPiOAuthLoginResult,
  isWikiIngestJob,
  isWikiProgressEvent,
  isWorkspaceSummary,
} from "./guards.ts"

describe("desktop contract validation", () => {
  it("accepts valid workflow requests", () => {
    expect(
      isCreateWorkspaceInput({
        selectionToken: "selection_1234567890",
        name: "AI Research",
        domain: "AI systems research",
      })
    ).toBe(true)
    expect(
      isIngestDocumentInput({
        documentToken: "document_1234567890",
        objective: "Capture the architectural tradeoffs.",
      })
    ).toBe(true)
    expect(isWikiSearchInput({ query: "attention", scope: "pages" })).toBe(true)
    expect(isCancelIngestInput({ jobId: "ingest_12345678" })).toBe(true)
  })

  it("rejects paths, unknown fields, blank text, and unsafe filters", () => {
    expect(
      isCreateWorkspaceInput({
        selectionToken: "selection_1234567890",
        name: "../escape",
        domain: "research",
      })
    ).toBe(false)
    expect(
      isIngestDocumentInput({
        documentToken: "../document.pdf",
        objective: "Summarize it",
      })
    ).toBe(false)
    expect(isWikiSearchInput({ query: "wiki", extra: true })).toBe(false)
    expect(isWikiSearchInput({ query: "wiki", tags: ["Not Safe"] })).toBe(false)
    expect(isCancelIngestInput({ jobId: "../other-job" })).toBe(false)
  })

  it("validates main-process responses before exposing them", () => {
    const workspace = {
      id: "wiki-id",
      name: "Research",
      domain: "Systems research",
      displayPath: "/research/wiki",
      commitHash: "abc123",
    }
    expect(
      isAmendResult({ ok: true, value: workspace }, isWorkspaceSummary)
    ).toBe(true)
    expect(
      isAmendResult(
        { ok: true, value: { ...workspace, secret: "must not cross preload" } },
        isWorkspaceSummary
      )
    ).toBe(false)
    expect(
      isSourceDocumentSelectionOrNull({
        token: "document_1234567890",
        displayName: "paper.pdf",
        suggestedTitle: "paper",
      })
    ).toBe(true)
    expect(
      isWikiProgressEvent({ phase: "indexing", message: "Indexing" })
    ).toBe(true)
    expect(isWikiProgressEvent({ phase: "unknown", message: "Indexing" })).toBe(
      false
    )
    expect(
      isWikiIngestJob({
        id: "ingest_12345678",
        title: "Attention Is All You Need",
        status: "running",
        phase: "writing",
        message: "Writing wiki pages",
        startedAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:00:01.000Z",
        revision: 2,
        cancellable: true,
      })
    ).toBe(true)
    expect(
      isWikiIngestJob({
        id: "ingest_12345678",
        title: "Attention Is All You Need",
        status: "completed",
        phase: "indexing",
        message: "Done",
        startedAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:00:01.000Z",
        revision: 3,
        cancellable: false,
      })
    ).toBe(false)
  })
})

describe("Pi credential contract validation", () => {
  it("accepts valid Pi requests", () => {
    expect(isPiListModelsInput({ provider: "zai" })).toBe(true)
    expect(isStartPiOAuthLoginInput({ provider: "anthropic" })).toBe(true)
    expect(isStartPiOAuthLoginInput({ provider: "openai-codex" })).toBe(true)
    expect(
      isPiSaveApiKeyInput({ provider: "zai", apiKey: "sk-example-key" })
    ).toBe(true)
    expect(
      isPiSetDefaultModelInput({ provider: "zai", model: "glm-5-turbo" })
    ).toBe(true)
    expect(
      isPiRespondToPromptInput({
        loginId: "a1b2c3d4",
        promptId: "e5f6a7b8",
        value: "123456",
      })
    ).toBe(true)
    expect(isPiCancelLoginInput({ loginId: "a1b2c3d4" })).toBe(true)
  })

  it("rejects unsupported OAuth providers and unsafe provider ids", () => {
    expect(isStartPiOAuthLoginInput({ provider: "github-copilot" })).toBe(false)
    expect(isPiListModelsInput({ provider: "../escape" })).toBe(false)
    expect(isPiListModelsInput({ provider: "Zai" })).toBe(false)
    expect(isPiSaveApiKeyInput({ provider: "zai", apiKey: "   " })).toBe(false)
  })

  it("validates Pi status, provider, model, and login-event responses", () => {
    expect(isPiConnectionStatus({ configured: false })).toBe(true)
    expect(
      isPiConnectionStatus({
        configured: true,
        provider: "zai",
        model: "glm-5-turbo",
      })
    ).toBe(true)
    expect(isPiConnectionStatus({ configured: true, secret: "leak" })).toBe(
      false
    )

    expect(
      isPiProviderSummaries([{ id: "zai", name: "ZAI Coding Plan (Global)" }])
    ).toBe(true)
    expect(
      isPiModelSummaries([{ id: "glm-5-turbo", name: "GLM-5-Turbo" }])
    ).toBe(true)
    expect(isStartPiOAuthLoginResult({ loginId: "a1b2c3d4" })).toBe(true)

    expect(
      isPiLoginEvent({
        loginId: "a1b2c3d4",
        type: "auth",
        url: "https://example.com/authorize",
      })
    ).toBe(true)
    expect(
      isPiLoginEvent({
        loginId: "a1b2c3d4",
        type: "prompt",
        promptId: "e5f6a7b8",
        message: "Paste the code from your browser",
      })
    ).toBe(true)
    expect(
      isPiLoginEvent({
        loginId: "a1b2c3d4",
        type: "failed",
        error: { code: "pi-failed", message: "Could not connect." },
      })
    ).toBe(true)
    expect(
      isPiLoginEvent({ loginId: "a1b2c3d4", type: "completed", extra: true })
    ).toBe(false)
  })
})
