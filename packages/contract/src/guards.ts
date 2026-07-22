import type {
  AmendError,
  AmendErrorCode,
  AmendResult,
  IngestPastedSourceResult,
  PiConnectionStatus,
  PiLoginEvent,
  PiModelSummary,
  PiProviderSummary,
  SourceDocumentSelection,
  StartIngestResult,
  StartPiOAuthLoginResult,
  StartWikiUpdateResult,
  WikiFileContent,
  WikiFileTreeItem,
  WikiIngestChangedEvent,
  WikiIngestJob,
  WikiUpdateActivity,
  WikiUpdateApplyResult,
  WikiUpdateChangedEvent,
  WikiUpdateChangedFile,
  WikiUpdateFileDiff,
  WikiUpdateMessage,
  WikiUpdateProposal,
  WikiUpdateSession,
  WikiIndexRefreshSummary,
  WikiProgressEvent,
  WikiSearchResult,
  WikiTagFacet,
  WikiHome,
  WikiListItem,
  WikiSummary,
} from "./index.ts"

export type Guard<T> = (value: unknown) => value is T

const errorCodes = new Set<AmendErrorCode>([
  "busy",
  "cancelled",
  "git-unavailable",
  "index-failed",
  "ingest-failed",
  "invalid-input",
  "invalid-location",
  "no-active-wiki",
  "operation-failed",
  "pi-configuration-missing",
  "pi-failed",
  "unauthorized",
  "update-conflict",
  "update-failed",
  "wiki-creation-failed",
  "wiki-open-failed",
])
const progressPhases = new Set<WikiProgressEvent["phase"]>([
  "preparing",
  "reading",
  "writing",
  "validating",
  "repairing",
  "committing",
  "indexing",
])

export function isAmendResult<T>(
  value: unknown,
  valueGuard: Guard<T>
): value is AmendResult<T> {
  if (!isRecord(value)) return false
  return value.ok === true
    ? hasOnlyKeys(value, ["ok", "value"]) && valueGuard(value.value)
    : value.ok === false &&
        hasOnlyKeys(value, ["ok", "error"]) &&
        isAmendError(value.error)
}

export const isNull: Guard<null> = (value): value is null => value === null

export const isWikiHomeOrNull: Guard<WikiHome | null> = (
  value
): value is WikiHome | null =>
  value === null ||
  (isRecord(value) &&
    hasOnlyKeys(value, ["displayPath"]) &&
    isString(value.displayPath))

export const isWikiSummary: Guard<WikiSummary> = (
  value
): value is WikiSummary =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "id",
    "name",
    "domain",
    "displayPath",
    "commitHash",
    "setupStatus",
  ]) &&
  isString(value.id) &&
  isString(value.name) &&
  isString(value.domain) &&
  isString(value.displayPath) &&
  isString(value.commitHash) &&
  (value.setupStatus === "initialized" || value.setupStatus === "ready")

export const isWikiSummaryOrNull: Guard<WikiSummary | null> = (
  value
): value is WikiSummary | null => value === null || isWikiSummary(value)

export const isWikiListItems: Guard<readonly WikiListItem[]> = (
  value
): value is readonly WikiListItem[] =>
  Array.isArray(value) && value.every(isWikiListItem)

export const isSourceDocumentSelection: Guard<SourceDocumentSelection> = (
  value
): value is SourceDocumentSelection =>
  isRecord(value) &&
  hasOnlyKeys(value, ["token", "displayName", "suggestedTitle"]) &&
  isString(value.token) &&
  isString(value.displayName) &&
  isString(value.suggestedTitle)

export const isSourceDocumentSelectionOrNull: Guard<
  SourceDocumentSelection | null
> = (value): value is SourceDocumentSelection | null =>
  value === null || isSourceDocumentSelection(value)

export const isWikiIndexRefreshSummary: Guard<WikiIndexRefreshSummary> = (
  value
): value is WikiIndexRefreshSummary =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "commitHash",
    "added",
    "updated",
    "removed",
    "unchanged",
  ]) &&
  isString(value.commitHash) &&
  isNumber(value.added) &&
  isNumber(value.updated) &&
  isNumber(value.removed) &&
  isNumber(value.unchanged)

export const isIngestPastedSourceResult: Guard<IngestPastedSourceResult> = (
  value
): value is IngestPastedSourceResult => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "runId",
      "commitHash",
      "changedFiles",
      "summary",
      "usage",
      "index",
    ]) ||
    !isString(value.runId) ||
    !isString(value.commitHash) ||
    !isStringArray(value.changedFiles) ||
    !isString(value.summary) ||
    (value.usage !== undefined && !isUsage(value.usage)) ||
    !isRecord(value.index)
  ) {
    return false
  }
  return value.index.status === "ready"
    ? hasOnlyKeys(value.index, ["status", "summary"]) &&
        isWikiIndexRefreshSummary(value.index.summary)
    : value.index.status === "failed" &&
        hasOnlyKeys(value.index, ["status", "error"]) &&
        isAmendError(value.index.error)
}

export const isStartIngestResult: Guard<StartIngestResult> = (
  value
): value is StartIngestResult =>
  isRecord(value) && hasOnlyKeys(value, ["jobId"]) && isJobId(value.jobId)

export const isWikiIngestJobOrNull: Guard<WikiIngestJob | null> = (
  value
): value is WikiIngestJob | null => value === null || isWikiIngestJob(value)

export const isWikiIngestJob: Guard<WikiIngestJob> = (
  value
): value is WikiIngestJob => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "title",
      "status",
      "phase",
      "message",
      "startedAt",
      "updatedAt",
      "revision",
      "cancellable",
      "result",
      "error",
    ]) ||
    !isJobId(value.id) ||
    !isString(value.title) ||
    !["running", "completed", "failed", "cancelled"].includes(
      String(value.status)
    ) ||
    typeof value.phase !== "string" ||
    !progressPhases.has(value.phase as WikiProgressEvent["phase"]) ||
    !isString(value.message) ||
    !isString(value.startedAt) ||
    !isString(value.updatedAt) ||
    !Number.isInteger(value.revision) ||
    Number(value.revision) < 0 ||
    typeof value.cancellable !== "boolean" ||
    (value.result !== undefined && !isIngestPastedSourceResult(value.result)) ||
    (value.error !== undefined && !isAmendError(value.error))
  ) {
    return false
  }
  if (value.status === "completed") {
    return (
      !value.cancellable &&
      value.result !== undefined &&
      value.error === undefined
    )
  }
  if (value.status === "failed" || value.status === "cancelled") {
    return (
      !value.cancellable &&
      value.result === undefined &&
      value.error !== undefined
    )
  }
  return value.result === undefined && value.error === undefined
}

export const isWikiIngestChangedEvent: Guard<WikiIngestChangedEvent> = (
  value
): value is WikiIngestChangedEvent =>
  isRecord(value) &&
  hasOnlyKeys(value, ["wikiId", "job"]) &&
  isString(value.wikiId) &&
  isWikiIngestJob(value.job)

export const isWikiSearchResults: Guard<readonly WikiSearchResult[]> = (
  value
): value is readonly WikiSearchResult[] =>
  Array.isArray(value) && value.every(isWikiSearchResult)

export const isWikiTagFacets: Guard<readonly WikiTagFacet[]> = (
  value
): value is readonly WikiTagFacet[] =>
  Array.isArray(value) &&
  value.every(
    (facet) =>
      isRecord(facet) &&
      hasOnlyKeys(facet, ["tag", "count"]) &&
      isString(facet.tag) &&
      isNumber(facet.count)
  )

export const isWikiFileTreeItems: Guard<readonly WikiFileTreeItem[]> = (
  value
): value is readonly WikiFileTreeItem[] =>
  Array.isArray(value) && value.every(isWikiFileTreeItem)

export const isWikiFileContent: Guard<WikiFileContent> = (
  value
): value is WikiFileContent =>
  isRecord(value) &&
  hasOnlyKeys(value, ["path", "name", "mediaType", "size", "content"]) &&
  isString(value.path) &&
  isString(value.name) &&
  ["markdown", "text", "binary"].includes(String(value.mediaType)) &&
  isNumber(value.size) &&
  (value.content === undefined || isString(value.content)) &&
  (value.mediaType === "binary"
    ? value.content === undefined
    : isString(value.content))

export const isStartWikiUpdateResult: Guard<StartWikiUpdateResult> = (
  value
): value is StartWikiUpdateResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["sessionId"]) &&
  isJobId(value.sessionId)

export const isWikiUpdateSessionOrNull: Guard<WikiUpdateSession | null> = (
  value
): value is WikiUpdateSession | null =>
  value === null || isWikiUpdateSession(value)

export const isWikiUpdateSession: Guard<WikiUpdateSession> = (
  value
): value is WikiUpdateSession =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "id",
    "wikiId",
    "baseCommit",
    "status",
    "revision",
    "updatedAt",
    "cancellable",
    "messages",
    "activity",
    "proposal",
    "error",
    "usage",
  ]) &&
  isJobId(value.id) &&
  isString(value.wikiId) &&
  isString(value.baseCommit) &&
  ["running", "review", "applying", "failed"].includes(String(value.status)) &&
  Number.isInteger(value.revision) &&
  Number(value.revision) >= 0 &&
  isString(value.updatedAt) &&
  typeof value.cancellable === "boolean" &&
  Array.isArray(value.messages) &&
  value.messages.every(isWikiUpdateMessage) &&
  Array.isArray(value.activity) &&
  value.activity.every(isWikiUpdateActivity) &&
  (value.proposal === undefined || isWikiUpdateProposal(value.proposal)) &&
  (value.error === undefined || isAmendError(value.error)) &&
  (value.usage === undefined || isUsage(value.usage))

export const isWikiUpdateChangedEvent: Guard<WikiUpdateChangedEvent> = (
  value
): value is WikiUpdateChangedEvent =>
  isRecord(value) &&
  hasOnlyKeys(value, ["wikiId", "session"]) &&
  isString(value.wikiId) &&
  (value.session === null || isWikiUpdateSession(value.session))

export const isWikiUpdateFileDiff: Guard<WikiUpdateFileDiff> = (
  value
): value is WikiUpdateFileDiff =>
  isRecord(value) &&
  hasOnlyKeys(value, ["path", "patch"]) &&
  isString(value.path) &&
  isString(value.patch)

export const isWikiUpdateApplyResult: Guard<WikiUpdateApplyResult> = (
  value
): value is WikiUpdateApplyResult =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "runId",
    "commitHash",
    "changedFiles",
    "summary",
    "usage",
    "index",
  ]) &&
  isJobId(value.runId) &&
  isString(value.commitHash) &&
  isStringArray(value.changedFiles) &&
  isString(value.summary) &&
  (value.usage === undefined || isUsage(value.usage)) &&
  isRecord(value.index) &&
  (value.index.status === "ready"
    ? hasOnlyKeys(value.index, ["status", "summary"]) &&
      isWikiIndexRefreshSummary(value.index.summary)
    : value.index.status === "failed" &&
      hasOnlyKeys(value.index, ["status", "error"]) &&
      isAmendError(value.index.error))

export const isPiConnectionStatus: Guard<PiConnectionStatus> = (
  value
): value is PiConnectionStatus =>
  isRecord(value) &&
  hasOnlyKeys(value, ["configured", "provider", "model"]) &&
  typeof value.configured === "boolean" &&
  (value.provider === undefined || isString(value.provider)) &&
  (value.model === undefined || isString(value.model))

function isPiProviderSummary(value: unknown): value is PiProviderSummary {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "name"]) &&
    isString(value.id) &&
    isString(value.name)
  )
}

export const isPiProviderSummaries: Guard<readonly PiProviderSummary[]> = (
  value
): value is readonly PiProviderSummary[] =>
  Array.isArray(value) && value.every(isPiProviderSummary)

export const isPiModelSummaries: Guard<readonly PiModelSummary[]> = (
  value
): value is readonly PiModelSummary[] =>
  Array.isArray(value) && value.every(isPiProviderSummary)

export const isStartPiOAuthLoginResult: Guard<StartPiOAuthLoginResult> = (
  value
): value is StartPiOAuthLoginResult =>
  isRecord(value) && hasOnlyKeys(value, ["loginId"]) && isJobId(value.loginId)

const piLoginEventTypes = new Set([
  "progress",
  "auth",
  "prompt",
  "completed",
  "cancelled",
  "failed",
])

export const isPiLoginEvent: Guard<PiLoginEvent> = (
  value
): value is PiLoginEvent => {
  if (
    !isRecord(value) ||
    !isJobId(value.loginId) ||
    typeof value.type !== "string" ||
    !piLoginEventTypes.has(value.type)
  ) {
    return false
  }
  switch (value.type) {
    case "progress":
      return (
        hasOnlyKeys(value, ["loginId", "type", "message"]) &&
        isString(value.message)
      )
    case "auth":
      return (
        hasOnlyKeys(value, ["loginId", "type", "url", "instructions"]) &&
        isString(value.url) &&
        (value.instructions === undefined || isString(value.instructions))
      )
    case "prompt":
      return (
        hasOnlyKeys(value, [
          "loginId",
          "type",
          "promptId",
          "message",
          "placeholder",
        ]) &&
        isJobId(value.promptId) &&
        isString(value.message) &&
        (value.placeholder === undefined || isString(value.placeholder))
      )
    case "completed":
    case "cancelled":
      return hasOnlyKeys(value, ["loginId", "type"])
    case "failed":
      return (
        hasOnlyKeys(value, ["loginId", "type", "error"]) &&
        isAmendError(value.error)
      )
    default:
      return false
  }
}

export const isWikiProgressEvent: Guard<WikiProgressEvent> = (
  value
): value is WikiProgressEvent =>
  isRecord(value) &&
  hasOnlyKeys(value, ["phase", "message"]) &&
  typeof value.phase === "string" &&
  progressPhases.has(value.phase as WikiProgressEvent["phase"]) &&
  isString(value.message)

function isAmendError(value: unknown): value is AmendError {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["code", "message"]) &&
    typeof value.code === "string" &&
    errorCodes.has(value.code as AmendErrorCode) &&
    isString(value.message)
  )
}

function isUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["inputTokens", "outputTokens", "cost"]) &&
    isNumber(value.inputTokens) &&
    isNumber(value.outputTokens) &&
    isNumber(value.cost)
  )
}

function isWikiUpdateMessage(value: unknown): value is WikiUpdateMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "role", "content", "status", "createdAt"]) &&
    isJobId(value.id) &&
    (value.role === "user" || value.role === "assistant") &&
    isString(value.content) &&
    (value.status === "streaming" || value.status === "complete") &&
    isString(value.createdAt)
  )
}

function isWikiUpdateActivity(value: unknown): value is WikiUpdateActivity {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "tool", "label", "status"]) &&
    isJobId(value.id) &&
    [
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
      "validate",
      "repair",
    ].includes(String(value.tool)) &&
    isString(value.label) &&
    ["running", "complete", "failed"].includes(String(value.status))
  )
}

function isWikiUpdateProposal(value: unknown): value is WikiUpdateProposal {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["summary", "changedFiles"]) &&
    isString(value.summary) &&
    Array.isArray(value.changedFiles) &&
    value.changedFiles.every(isWikiUpdateChangedFile)
  )
}

function isWikiUpdateChangedFile(
  value: unknown
): value is WikiUpdateChangedFile {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["path", "status", "additions", "deletions"]) &&
    isString(value.path) &&
    ["added", "modified", "deleted"].includes(String(value.status)) &&
    Number.isInteger(value.additions) &&
    Number(value.additions) >= 0 &&
    Number.isInteger(value.deletions) &&
    Number(value.deletions) >= 0
  )
}

function isWikiSearchResult(value: unknown): value is WikiSearchResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "kind",
      "path",
      "title",
      "pageType",
      "sourceKind",
      "tags",
      "heading",
      "snippet",
      "highlights",
      "score",
    ]) &&
    (value.kind === "page" || value.kind === "source") &&
    isString(value.path) &&
    isString(value.title) &&
    (value.pageType === undefined ||
      ["entity", "concept", "comparison", "query"].includes(
        String(value.pageType)
      )) &&
    (value.sourceKind === undefined ||
      ["article", "paper", "transcript"].includes(String(value.sourceKind))) &&
    isStringArray(value.tags) &&
    (value.heading === undefined || isString(value.heading)) &&
    isString(value.snippet) &&
    Array.isArray(value.highlights) &&
    value.highlights.every(
      (highlight) =>
        isRecord(highlight) &&
        hasOnlyKeys(highlight, ["start", "end"]) &&
        isNumber(highlight.start) &&
        isNumber(highlight.end)
    ) &&
    isNumber(value.score)
  )
}

function isWikiFileTreeItem(value: unknown): value is WikiFileTreeItem {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["path", "name", "kind", "children"]) ||
    !isString(value.path) ||
    !isString(value.name) ||
    (value.kind !== "directory" && value.kind !== "file")
  ) {
    return false
  }
  if (value.kind === "file") return value.children === undefined
  return (
    value.children === undefined ||
    (Array.isArray(value.children) && value.children.every(isWikiFileTreeItem))
  )
}

function isWikiListItem(value: unknown): value is WikiListItem {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "name", "displayPath", "active", "running"]) &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.displayPath) &&
    typeof value.active === "boolean" &&
    typeof value.running === "boolean"
  )
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isJobId(value: unknown): value is string {
  return (
    isString(value) &&
    value.length >= 8 &&
    value.length <= 128 &&
    /^[a-zA-Z0-9_-]+$/.test(value)
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}
