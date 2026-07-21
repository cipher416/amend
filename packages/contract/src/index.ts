import { Type } from "typebox"
import { Value } from "typebox/value"

export { amendChannels } from "./channels.ts"

export type AmendErrorCode =
  | "busy"
  | "cancelled"
  | "git-unavailable"
  | "index-failed"
  | "ingest-failed"
  | "invalid-input"
  | "invalid-location"
  | "no-active-workspace"
  | "operation-failed"
  | "pi-configuration-missing"
  | "pi-failed"
  | "unauthorized"
  | "workspace-creation-failed"
  | "workspace-open-failed"

export interface AmendError {
  code: AmendErrorCode
  message: string
}

export type AmendResult<T> =
  { ok: true; value: T } | { ok: false; error: AmendError }

export interface WorkspaceParentSelection {
  token: string
  displayPath: string
}

export interface CreateWorkspaceInput {
  selectionToken: string
  name: string
  domain: string
}

export interface WorkspaceListItem {
  id: string
  name: string
  displayPath: string
  active: boolean
  running: boolean
}

export interface ActivateWorkspaceInput {
  workspaceId: string
}

export interface WorkspaceSummary {
  id: string
  name: string
  domain: string
  displayPath: string
  commitHash: string
  setupStatus: "initialized" | "ready"
}

export interface SourceDocumentSelection {
  token: string
  displayName: string
  suggestedTitle: string
}

export interface IngestDocumentInput {
  documentToken: string
  objective: string
}

export interface CancelIngestInput {
  jobId: string
}

export interface WikiUsage {
  inputTokens: number
  outputTokens: number
  cost: number
}

export interface WikiIndexRefreshSummary {
  commitHash: string
  added: number
  updated: number
  removed: number
  unchanged: number
}

export interface IngestPastedSourceResult {
  runId: string
  commitHash: string
  changedFiles: readonly string[]
  summary: string
  usage?: WikiUsage
  index:
    | { status: "ready"; summary: WikiIndexRefreshSummary }
    | { status: "failed"; error: AmendError }
}

export interface StartIngestResult {
  jobId: string
}

export type WikiIngestJobStatus =
  "running" | "completed" | "failed" | "cancelled"

export interface WikiIngestJob {
  id: string
  title: string
  status: WikiIngestJobStatus
  phase: WikiProgressPhase
  message: string
  startedAt: string
  updatedAt: string
  revision: number
  cancellable: boolean
  result?: IngestPastedSourceResult
  error?: AmendError
}

export interface WikiIngestChangedEvent {
  workspaceId: string
  job: WikiIngestJob
}

export type WikiSearchScope = "all" | "pages" | "sources"
export type WikiPageType = "entity" | "concept" | "comparison" | "query"

export interface WikiSearchInput {
  query: string
  scope?: WikiSearchScope
  pageTypes?: readonly WikiPageType[]
  tags?: readonly string[]
  limit?: number
}

export interface WikiSearchHighlight {
  start: number
  end: number
}

export interface WikiSearchResult {
  kind: "page" | "source"
  path: string
  title: string
  pageType?: WikiPageType
  sourceKind?: "article" | "paper" | "transcript"
  tags: readonly string[]
  heading?: string
  snippet: string
  highlights: readonly WikiSearchHighlight[]
  score: number
}

export interface WikiTagFacet {
  tag: string
  count: number
}

export interface WikiFileTreeItem {
  path: string
  name: string
  kind: "directory" | "file"
  children?: readonly WikiFileTreeItem[]
}

export interface ReadWikiFileInput {
  path: string
}

export interface WikiFileContent {
  path: string
  name: string
  mediaType: "markdown" | "text" | "binary"
  size: number
  content?: string
}

export type WikiProgressPhase =
  | "preparing"
  | "reading"
  | "writing"
  | "validating"
  | "repairing"
  | "committing"
  | "indexing"

export interface WikiProgressEvent {
  phase: WikiProgressPhase
  message: string
}

export const piOAuthProviderIds = ["anthropic", "openai-codex"] as const
export type PiOAuthProviderId = (typeof piOAuthProviderIds)[number]

export interface PiConnectionStatus {
  configured: boolean
  provider?: string
  model?: string
}

export interface PiProviderSummary {
  id: string
  name: string
}

export interface PiModelSummary {
  id: string
  name: string
}

export interface PiListModelsInput {
  provider: string
}

export interface StartPiOAuthLoginInput {
  provider: PiOAuthProviderId
}

export interface StartPiOAuthLoginResult {
  loginId: string
}

export interface PiSaveApiKeyInput {
  provider: string
  apiKey: string
}

export interface PiSetDefaultModelInput {
  provider: string
  model: string
}

export interface PiRespondToPromptInput {
  loginId: string
  promptId: string
  value: string
}

export interface PiCancelLoginInput {
  loginId: string
}

export const themeSources = ["light", "dark", "system"] as const
export type ThemeSource = (typeof themeSources)[number]

export type PiLoginEvent =
  | { loginId: string; type: "progress"; message: string }
  | { loginId: string; type: "auth"; url: string; instructions?: string }
  | {
      loginId: string
      type: "prompt"
      promptId: string
      message: string
      placeholder?: string
    }
  | { loginId: string; type: "completed" }
  | { loginId: string; type: "cancelled" }
  | { loginId: string; type: "failed"; error: AmendError }

export interface AmendApi {
  readonly runtime: "electron"
  readonly platform: string
  readonly appearance: {
    setTheme: (theme: ThemeSource) => Promise<AmendResult<null>>
  }
  readonly workspaces: {
    chooseLocation: () => Promise<AmendResult<WorkspaceParentSelection | null>>
    create: (
      input: CreateWorkspaceInput
    ) => Promise<AmendResult<WorkspaceSummary>>
    open: () => Promise<AmendResult<WorkspaceSummary | null>>
    current: () => Promise<AmendResult<WorkspaceSummary | null>>
    list: () => Promise<AmendResult<readonly WorkspaceListItem[]>>
    activate: (
      input: ActivateWorkspaceInput
    ) => Promise<AmendResult<WorkspaceSummary>>
  }
  readonly providers: {
    status: () => Promise<AmendResult<PiConnectionStatus>>
    list: () => Promise<AmendResult<readonly PiProviderSummary[]>>
    listModels: (
      input: PiListModelsInput
    ) => Promise<AmendResult<readonly PiModelSummary[]>>
    startOAuth: (
      input: StartPiOAuthLoginInput
    ) => Promise<AmendResult<StartPiOAuthLoginResult>>
    respondToOAuthPrompt: (
      input: PiRespondToPromptInput
    ) => Promise<AmendResult<null>>
    cancelOAuth: (input: PiCancelLoginInput) => Promise<AmendResult<null>>
    connectWithApiKey: (input: PiSaveApiKeyInput) => Promise<AmendResult<null>>
    setDefaultModel: (
      input: PiSetDefaultModelInput
    ) => Promise<AmendResult<null>>
    onOAuthEvent: (listener: (event: PiLoginEvent) => void) => () => void
  }
  readonly wiki: {
    chooseDocument: () => Promise<AmendResult<SourceDocumentSelection | null>>
    registerDocument: (
      file: File
    ) => Promise<AmendResult<SourceDocumentSelection>>
    startIngest: (
      input: IngestDocumentInput
    ) => Promise<AmendResult<StartIngestResult>>
    currentIngest: () => Promise<AmendResult<WikiIngestJob | null>>
    cancelIngest: (input: CancelIngestInput) => Promise<AmendResult<null>>
    refreshIndex: () => Promise<AmendResult<WikiIndexRefreshSummary>>
    listFiles: () => Promise<AmendResult<readonly WikiFileTreeItem[]>>
    readFile: (
      input: ReadWikiFileInput
    ) => Promise<AmendResult<WikiFileContent>>
    search: (
      input: WikiSearchInput
    ) => Promise<AmendResult<readonly WikiSearchResult[]>>
    listTags: () => Promise<AmendResult<readonly WikiTagFacet[]>>
    onIngestChanged: (
      listener: (event: WikiIngestChangedEvent) => void
    ) => () => void
  }
}

const selectionTokenSchema = Type.String({
  minLength: 16,
  maxLength: 128,
  pattern: "^[a-zA-Z0-9_-]+$",
})
const nonBlankText = (maxLength: number) =>
  Type.Refine(
    Type.String({ maxLength }),
    (value) => value.trim().length > 0,
    () => "Value must contain non-whitespace text"
  )
const workspaceNameSchema = Type.Refine(
  Type.String({ minLength: 1, maxLength: 80 }),
  (value) =>
    value.trim() === value &&
    value !== "." &&
    value !== ".." &&
    !/[\\/\0]/.test(value),
  () => "Workspace name must be a safe directory name"
)
const wikiPageTypeSchema = Type.Union([
  Type.Literal("entity"),
  Type.Literal("concept"),
  Type.Literal("comparison"),
  Type.Literal("query"),
])
const tagSchema = Type.String({
  minLength: 1,
  maxLength: 80,
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
})
const wikiFilePathSchema = Type.String({
  minLength: 1,
  maxLength: 1_000,
})

export const createWorkspaceInputSchema = Type.Object(
  {
    selectionToken: selectionTokenSchema,
    name: workspaceNameSchema,
    domain: nonBlankText(2_000),
  },
  { additionalProperties: false }
)

export const activateWorkspaceInputSchema = Type.Object(
  {
    workspaceId: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[a-zA-Z0-9_-]+$",
    }),
  },
  { additionalProperties: false }
)

const idempotencyIdSchema = Type.String({
  minLength: 8,
  maxLength: 128,
  pattern: "^[a-zA-Z0-9_-]+$",
})
const providerIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z0-9][a-z0-9-]*$",
})

export const piListModelsInputSchema = Type.Object(
  { provider: providerIdSchema },
  { additionalProperties: false }
)

export const startPiOAuthLoginInputSchema = Type.Object(
  {
    provider: Type.Union(piOAuthProviderIds.map((id) => Type.Literal(id))),
  },
  { additionalProperties: false }
)

export const piSaveApiKeyInputSchema = Type.Object(
  {
    provider: providerIdSchema,
    apiKey: nonBlankText(4_000),
  },
  { additionalProperties: false }
)

export const piSetDefaultModelInputSchema = Type.Object(
  {
    provider: providerIdSchema,
    model: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false }
)

export const piRespondToPromptInputSchema = Type.Object(
  {
    loginId: idempotencyIdSchema,
    promptId: idempotencyIdSchema,
    value: Type.String({ maxLength: 2_000 }),
  },
  { additionalProperties: false }
)

export const piCancelLoginInputSchema = Type.Object(
  { loginId: idempotencyIdSchema },
  { additionalProperties: false }
)

export const ingestDocumentInputSchema = Type.Object(
  {
    documentToken: selectionTokenSchema,
    objective: nonBlankText(10_000),
  },
  { additionalProperties: false }
)

export const cancelIngestInputSchema = Type.Object(
  {
    jobId: Type.String({
      minLength: 8,
      maxLength: 128,
      pattern: "^[a-zA-Z0-9_-]+$",
    }),
  },
  { additionalProperties: false }
)

export const wikiSearchInputSchema = Type.Object(
  {
    query: nonBlankText(256),
    scope: Type.Optional(
      Type.Union([
        Type.Literal("all"),
        Type.Literal("pages"),
        Type.Literal("sources"),
      ])
    ),
    pageTypes: Type.Optional(
      Type.Array(wikiPageTypeSchema, { maxItems: 4, uniqueItems: true })
    ),
    tags: Type.Optional(
      Type.Array(tagSchema, { maxItems: 32, uniqueItems: true })
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false }
)

export const readWikiFileInputSchema = Type.Object(
  { path: wikiFilePathSchema },
  { additionalProperties: false }
)

export function isCreateWorkspaceInput(
  value: unknown
): value is CreateWorkspaceInput {
  return Value.Check(createWorkspaceInputSchema, value)
}

export function isActivateWorkspaceInput(
  value: unknown
): value is ActivateWorkspaceInput {
  return Value.Check(activateWorkspaceInputSchema, value)
}

export function isIngestDocumentInput(
  value: unknown
): value is IngestDocumentInput {
  return Value.Check(ingestDocumentInputSchema, value)
}

export function isCancelIngestInput(
  value: unknown
): value is CancelIngestInput {
  return Value.Check(cancelIngestInputSchema, value)
}

export function isWikiSearchInput(value: unknown): value is WikiSearchInput {
  return Value.Check(wikiSearchInputSchema, value)
}

export function isReadWikiFileInput(
  value: unknown
): value is ReadWikiFileInput {
  return Value.Check(readWikiFileInputSchema, value)
}

export function isPiListModelsInput(
  value: unknown
): value is PiListModelsInput {
  return Value.Check(piListModelsInputSchema, value)
}

export function isStartPiOAuthLoginInput(
  value: unknown
): value is StartPiOAuthLoginInput {
  return Value.Check(startPiOAuthLoginInputSchema, value)
}

export function isPiSaveApiKeyInput(
  value: unknown
): value is PiSaveApiKeyInput {
  return Value.Check(piSaveApiKeyInputSchema, value)
}

export function isPiSetDefaultModelInput(
  value: unknown
): value is PiSetDefaultModelInput {
  return Value.Check(piSetDefaultModelInputSchema, value)
}

export function isPiRespondToPromptInput(
  value: unknown
): value is PiRespondToPromptInput {
  return Value.Check(piRespondToPromptInputSchema, value)
}

export function isPiCancelLoginInput(
  value: unknown
): value is PiCancelLoginInput {
  return Value.Check(piCancelLoginInputSchema, value)
}

export function isThemeSource(value: unknown): value is ThemeSource {
  return (
    typeof value === "string" && themeSources.some((theme) => theme === value)
  )
}
