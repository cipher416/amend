import { describe, expect, it } from "vitest"

import {
  isCreateWorkspaceInput,
  isCancelIngestInput,
  isIngestDocumentInput,
  isWikiSearchInput,
} from "./index.ts"
import {
  isAmendResult,
  isSourceDocumentSelectionOrNull,
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
