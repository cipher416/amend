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

export interface WorkspaceSummary {
  id: string
  name: string
  domain: string
  displayPath: string
  commitHash: string
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

export interface AmendApi {
  readonly runtime: "electron"
  readonly platform: string
  readonly workspace: {
    chooseParent: () => Promise<AmendResult<WorkspaceParentSelection | null>>
    create: (
      input: CreateWorkspaceInput
    ) => Promise<AmendResult<WorkspaceSummary>>
    current: () => Promise<AmendResult<WorkspaceSummary | null>>
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
    search: (
      input: WikiSearchInput
    ) => Promise<AmendResult<readonly WikiSearchResult[]>>
    listTags: () => Promise<AmendResult<readonly WikiTagFacet[]>>
    onIngestChanged: (listener: (job: WikiIngestJob) => void) => () => void
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

export const createWorkspaceInputSchema = Type.Object(
  {
    selectionToken: selectionTokenSchema,
    name: workspaceNameSchema,
    domain: nonBlankText(2_000),
  },
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

export function isCreateWorkspaceInput(
  value: unknown
): value is CreateWorkspaceInput {
  return Value.Check(createWorkspaceInputSchema, value)
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
