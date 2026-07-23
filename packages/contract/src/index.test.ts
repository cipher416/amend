import { describe, expect, it } from "vitest"

import { amendChannels } from "./channels.ts"
import {
  isActivateWikiInput,
  isCancelIngestInput,
  isCreateWikiInput,
  isDeleteWikiInput,
  isContinueWikiUpdateInput,
  isIngestDocumentInput,
  isPiCancelLoginInput,
  isPiListModelsInput,
  isPiRespondToPromptInput,
  isPiSaveApiKeyInput,
  isPiSetDefaultModelInput,
  isReadWikiFileInput,
  isReadWikiUpdateDiffInput,
  isRenameWikiInput,
  isStartWikiUpdateInput,
  isStartPiOAuthLoginInput,
  isThemeSource,
  isWikiSearchInput,
  isWikiUpdateSessionInput,
} from "./index.ts"
import {
  isAmendResult,
  isPiConnectionStatus,
  isPiLoginEvent,
  isPiModelSummaries,
  isPiProviderSummaries,
  isSourceDocumentSelectionOrNull,
  isStartPiOAuthLoginResult,
  isWikiFileContent,
  isWikiFileTreeItems,
  isWikiIngestChangedEvent,
  isWikiIngestJob,
  isWikiProgressEvent,
  isWikiListItems,
  isWikiSummary,
  isWikiSummaryOrNull,
  isStartWikiUpdateResult,
  isWikiUpdateApplyResult,
  isWikiUpdateChangedEvent,
  isWikiUpdateFileDiff,
  isWikiUpdateSession,
} from "./guards.ts"

describe("desktop contract validation", () => {
  it("uses plural wiki and provider channel namespaces", () => {
    expect(amendChannels).toMatchObject({
      chooseWikiHome: "amend:wikis:choose-home",
      getWikiHome: "amend:wikis:home",
      createWiki: "amend:wikis:create",
      getCurrentWiki: "amend:wikis:current",
      listWikis: "amend:wikis:list",
      activateWiki: "amend:wikis:activate",
      renameWiki: "amend:wikis:rename",
      deleteWiki: "amend:wikis:delete",
      setAppearanceTheme: "amend:appearance:set-theme",
      getProviderStatus: "amend:providers:status",
      listProviders: "amend:providers:list",
      listProviderModels: "amend:providers:list-models",
      startProviderOAuth: "amend:providers:start-oauth",
      respondToProviderOAuthPrompt: "amend:providers:respond-to-oauth-prompt",
      cancelProviderOAuth: "amend:providers:cancel-oauth",
      connectProviderWithApiKey: "amend:providers:connect-with-api-key",
      setDefaultProviderModel: "amend:providers:set-default-model",
      providerOAuthEvent: "amend:providers:oauth-event",
      listWikiFiles: "amend:wiki:list-files",
      readWikiFile: "amend:wiki:read-file",
      startWikiUpdate: "amend:wiki:update:start",
      wikiUpdateChanged: "amend:wiki:update:changed",
    })
  })

  it("accepts valid workflow requests", () => {
    expect(
      isCreateWikiInput({
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
    expect(isActivateWikiInput({ wikiId: "wiki_12345678" })).toBe(true)
    expect(
      isRenameWikiInput({
        wikiId: "wiki_12345678",
        name: "Renamed Research",
      })
    ).toBe(true)
    expect(isDeleteWikiInput({ wikiId: "wiki_12345678" })).toBe(true)
    expect(isReadWikiFileInput({ path: "concepts/cache.md" })).toBe(true)
    expect(
      isStartWikiUpdateInput({
        prompt: "Clarify the cache invalidation section.",
        contextPath: "concepts/cache.md",
      })
    ).toBe(true)
    expect(
      isContinueWikiUpdateInput({
        sessionId: "update_12345678",
        prompt: "Also add an example.",
      })
    ).toBe(true)
    expect(isWikiUpdateSessionInput({ sessionId: "update_12345678" })).toBe(
      true
    )
    expect(
      isReadWikiUpdateDiffInput({
        sessionId: "update_12345678",
        path: "concepts/cache.md",
      })
    ).toBe(true)
    expect(isThemeSource("system")).toBe(true)
  })

  it("rejects paths, unknown fields, blank text, and unsafe filters", () => {
    expect(
      isCreateWikiInput({
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
    expect(isActivateWikiInput({ wikiId: "../other-wiki" })).toBe(false)
    expect(
      isRenameWikiInput({
        wikiId: "wiki_12345678",
        name: "../escape",
      })
    ).toBe(false)
    expect(isDeleteWikiInput({ wikiId: "../other-wiki" })).toBe(false)
    expect(isDeleteWikiInput({ wikiId: "wiki_12345678", extra: true })).toBe(
      false
    )
    expect(
      isRenameWikiInput({
        wikiId: "../other-wiki",
        name: "Research",
      })
    ).toBe(false)
    expect(
      isRenameWikiInput({
        wikiId: "wiki_12345678",
        name: "Research",
        extra: true,
      })
    ).toBe(false)
    expect(
      isActivateWikiInput({
        wikiId: "wiki_12345678",
        displayPath: "/must/not/cross/ipc",
      })
    ).toBe(false)
    expect(isReadWikiFileInput({ path: "" })).toBe(false)
    expect(isStartWikiUpdateInput({ prompt: "   " })).toBe(false)
    expect(
      isContinueWikiUpdateInput({
        sessionId: "../escape",
        prompt: "Continue",
      })
    ).toBe(false)
    expect(
      isReadWikiFileInput({ path: "concepts/cache.md", extra: true })
    ).toBe(false)
    expect(isThemeSource("auto")).toBe(false)
  })

  it("validates main-process responses before exposing them", () => {
    const workspace = {
      id: "wiki-id",
      name: "Research",
      domain: "Systems research",
      displayPath: "/research/wiki",
      commitHash: "abc123",
      setupStatus: "ready",
    }
    expect(isAmendResult({ ok: true, value: workspace }, isWikiSummary)).toBe(
      true
    )
    expect(isWikiSummary({ ...workspace, setupStatus: "initialized" })).toBe(
      true
    )
    expect(isAmendResult({ ok: true, value: null }, isWikiSummaryOrNull)).toBe(
      true
    )
    expect(
      isAmendResult(
        {
          ok: false,
          error: {
            code: "wiki-open-failed",
            message: "The wiki could not be opened.",
          },
        },
        isWikiSummaryOrNull
      )
    ).toBe(true)
    expect(
      isAmendResult(
        { ok: true, value: { ...workspace, secret: "must not cross preload" } },
        isWikiSummary
      )
    ).toBe(false)
    expect(
      isWikiSummary({
        id: "wiki-id",
        name: "Research",
        domain: "Systems research",
        displayPath: "/research/wiki",
        commitHash: "abc123",
      })
    ).toBe(false)
    expect(isWikiSummary({ ...workspace, setupStatus: "complete" })).toBe(false)
    const workspaceListItem = {
      id: "wiki_12345678",
      name: "Research",
      displayPath: "/research/wiki",
      active: true,
      running: false,
    }
    expect(isWikiListItems([workspaceListItem])).toBe(true)
    expect(
      isAmendResult({ ok: true, value: [workspaceListItem] }, isWikiListItems)
    ).toBe(true)
    expect(isWikiListItems([{ ...workspaceListItem, running: "no" }])).toBe(
      false
    )
    expect(
      isWikiListItems([{ ...workspaceListItem, domain: "must not cross" }])
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
    expect(
      isWikiFileTreeItems([
        {
          path: "concepts",
          name: "concepts",
          kind: "directory",
          children: [
            { path: "concepts/cache.md", name: "cache.md", kind: "file" },
          ],
        },
      ])
    ).toBe(true)
    expect(
      isWikiFileTreeItems([
        {
          path: "concepts/cache.md",
          name: "cache.md",
          kind: "file",
          children: [],
        },
      ])
    ).toBe(false)
    expect(
      isWikiFileContent({
        path: "concepts/cache.md",
        name: "cache.md",
        mediaType: "markdown",
        size: 12,
        content: "# Cache",
      })
    ).toBe(true)
    expect(
      isWikiFileContent({
        path: "sources/paper.pdf",
        name: "paper.pdf",
        mediaType: "binary",
        size: 12,
        content: "must not cross",
      })
    ).toBe(false)
  })

  it("validates wiki-scoped ingest events", () => {
    const runningJob = {
      id: "ingest_12345678",
      title: "Attention Is All You Need",
      status: "running" as const,
      phase: "writing" as const,
      message: "Writing wiki pages",
      startedAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:01.000Z",
      revision: 2,
      cancellable: true,
    }
    expect(
      isWikiIngestChangedEvent({
        wikiId: "wiki_12345678",
        job: runningJob,
      })
    ).toBe(true)
    expect(
      isWikiIngestChangedEvent({
        wikiId: "wiki_12345678",
        job: { ...runningJob, status: "unknown" },
      })
    ).toBe(false)
    expect(
      isWikiIngestChangedEvent({
        wikiId: "wiki_12345678",
        job: runningJob,
        extra: true,
      })
    ).toBe(false)
    expect(isWikiIngestChangedEvent({ wikiId: 42, job: runningJob })).toBe(
      false
    )
  })

  it("validates wiki update sessions, events, diffs, and apply results", () => {
    const session = {
      id: "update_12345678",
      wikiId: "wiki_12345678",
      baseCommit: "abc123",
      status: "review" as const,
      revision: 4,
      updatedAt: "2026-07-22T12:00:00.000Z",
      cancellable: false,
      messages: [
        {
          id: "message_12345678",
          role: "user" as const,
          content: "Clarify cache invalidation.",
          status: "complete" as const,
          createdAt: "2026-07-22T11:59:00.000Z",
        },
      ],
      activity: [
        {
          id: "activity_12345678",
          tool: "edit" as const,
          label: "Edited concepts/cache.md",
          status: "complete" as const,
        },
      ],
      proposal: {
        summary: "Clarify cache invalidation",
        changedFiles: [
          {
            path: "concepts/cache.md",
            status: "modified" as const,
            additions: 5,
            deletions: 2,
          },
        ],
      },
    }
    expect(isWikiUpdateSession(session)).toBe(true)
    expect(isWikiUpdateChangedEvent({ wikiId: "wiki_12345678", session })).toBe(
      true
    )
    expect(
      isWikiUpdateChangedEvent({
        wikiId: "wiki_12345678",
        session: { ...session, revision: -1 },
      })
    ).toBe(false)
    expect(
      isWikiUpdateFileDiff({
        path: "concepts/cache.md",
        patch: "@@ -1 +1 @@",
      })
    ).toBe(true)
    expect(isStartWikiUpdateResult({ sessionId: "update_12345678" })).toBe(true)
    expect(
      isWikiUpdateApplyResult({
        runId: "update_12345678",
        commitHash: "def456",
        changedFiles: ["concepts/cache.md", "log.md"],
        summary: "Clarify cache invalidation",
        index: {
          status: "ready",
          summary: {
            commitHash: "def456",
            added: 0,
            updated: 2,
            removed: 0,
            unchanged: 3,
          },
        },
      })
    ).toBe(true)
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
