import { Type } from "typebox"
import type { TLocalizedValidationError } from "typebox/error"
import { Value } from "typebox/value"
import { parse as parseYaml } from "yaml"

export const wikiPageDirectories = [
  "entities",
  "concepts",
  "comparisons",
  "queries",
] as const

export const wikiPageDirectoryList = formatList(
  wikiPageDirectories.map((directory) => `${directory}/`)
)

export type WikiPageType = "entity" | "concept" | "comparison" | "query"
export type WikiSourceKind = "article" | "paper" | "transcript"

export interface WikiFormatDiagnostic {
  code: string
  message: string
}

export interface WikiPageMetadata {
  title?: string
  pageType?: WikiPageType
  tags: string[]
  sourcePaths: string[]
  diagnostics: WikiFormatDiagnostic[]
}

const pageTypesByDirectory = new Map<string, WikiPageType>([
  ["entities", "entity"],
  ["concepts", "concept"],
  ["comparisons", "comparison"],
  ["queries", "query"],
])

function formatList(values: readonly string[]): string {
  if (values.length === 0) return ""
  if (values.length === 1) return values[0] ?? ""
  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`
}

const tagPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const sourcePathPattern =
  /^raw\/(?:articles|papers|transcripts)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
const titleSchema = Type.Refine(
  Type.String(),
  (value) => value.trim().length > 0,
  () => "Page title must be non-empty text"
)
const isoDateSchema = Type.Refine(
  Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  isIsoDate,
  () => "Date must be a valid ISO date in YYYY-MM-DD format"
)
const pageTypeSchema = Type.Union([
  Type.Literal("entity"),
  Type.Literal("concept"),
  Type.Literal("comparison"),
  Type.Literal("query"),
])
const tagSchema = Type.String({ pattern: tagPattern.source })
const tagsSchema = Type.Array(tagSchema, { minItems: 1, uniqueItems: true })
const sourcePathSchema = Type.String({ pattern: sourcePathPattern.source })
const sourcePathsSchema = Type.Array(sourcePathSchema, {
  minItems: 1,
  uniqueItems: true,
})
const wikiPageFrontmatterSchema = Type.Object(
  {
    title: titleSchema,
    created: isoDateSchema,
    updated: isoDateSchema,
    type: pageTypeSchema,
    tags: tagsSchema,
    sources: sourcePathsSchema,
  },
  { additionalProperties: true }
)

export function wikiPageTypeForPath(path: string): WikiPageType | undefined {
  const match =
    /^(entities|concepts|comparisons|queries)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.exec(
      path
    )
  return match ? pageTypesByDirectory.get(match[1]) : undefined
}

export function wikiSourceKindForPath(
  path: string
): WikiSourceKind | undefined {
  const match =
    /^raw\/(articles|papers|transcripts)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.exec(
      path
    )
  if (!match) return undefined
  return {
    articles: "article",
    papers: "paper",
    transcripts: "transcript",
  }[match[1]] as WikiSourceKind | undefined
}

export function isValidSourcePath(path: string): boolean {
  return Value.Check(sourcePathSchema, path)
}

export function parseMarkdownFrontmatter(
  content: string,
  path: string
): { frontmatter: Map<string, unknown>; body: string } {
  if (!content.startsWith("---\n")) {
    throw new Error(`Wiki page is missing YAML frontmatter: ${path}`)
  }
  const end = content.indexOf("\n---\n", 4)
  if (end === -1) {
    throw new Error(`Wiki page frontmatter is not closed: ${path}`)
  }
  const value = parseYaml(content.slice(4, end)) as unknown
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Wiki page frontmatter must be a YAML object: ${path}`)
  }
  assertSafeValidationValue(value)
  return {
    frontmatter: new Map(Object.entries(value)),
    body: content.slice(end + "\n---\n".length).replace(/^\n/, ""),
  }
}

export function validateWikiTags(value: unknown): {
  tags: string[]
  errors: string[]
} {
  try {
    assertSafeValidationValue(value)
    if (Value.Check(tagsSchema, value)) return { tags: [...value], errors: [] }
    return {
      tags: [],
      errors: Value.Errors(tagsSchema, value).map((error) =>
        tagValidationMessage(error, value)
      ),
    }
  } catch (error) {
    return {
      tags: [],
      errors: [
        error instanceof Error ? error.message : "Tags could not be validated",
      ],
    }
  }
}

export function readWikiPageMetadata(
  frontmatter: ReadonlyMap<string, unknown>,
  pagePath: string
): WikiPageMetadata {
  const value = Object.fromEntries(frontmatter)
  try {
    assertSafeValidationValue(value)
  } catch (error) {
    return {
      tags: [],
      sourcePaths: [],
      diagnostics: [
        {
          code: "frontmatter.invalid",
          message:
            error instanceof Error
              ? error.message
              : "Frontmatter could not be validated",
        },
      ],
    }
  }
  const diagnostics: WikiFormatDiagnostic[] = []
  for (const [field, schema] of Object.entries(
    wikiPageFrontmatterSchema.properties
  )) {
    if (!Object.hasOwn(value, field)) {
      diagnostics.push({
        code: "frontmatter.missing-field",
        message: `Missing required frontmatter field: ${field}`,
      })
      continue
    }
    diagnostics.push(
      ...Value.Errors(schema, value[field]).flatMap((error) =>
        frontmatterDiagnostics(field, error, value)
      )
    )
  }
  const title = Value.Check(titleSchema, value.title)
    ? value.title.trim()
    : undefined
  const pageType = Value.Check(pageTypeSchema, value.type)
    ? value.type
    : undefined
  const pathType = pageTypesByDirectory.get(pagePath.split("/", 1)[0] ?? "")
  if (pageType && pathType && pageType !== pathType) {
    diagnostics.push({
      code: "frontmatter.type-directory-mismatch",
      message: `Page type ${pageType} does not match its directory`,
    })
  }
  const tags = Value.Check(tagsSchema, value.tags) ? [...value.tags] : []
  const sourcePaths = Array.isArray(value.sources)
    ? value.sources.filter(
        (sourcePath, index, sources): sourcePath is string =>
          Value.Check(sourcePathSchema, sourcePath) &&
          sources.indexOf(sourcePath) === index
      )
    : []

  return {
    title,
    pageType,
    tags,
    sourcePaths,
    diagnostics: deduplicateDiagnostics(diagnostics),
  }
}

function frontmatterDiagnostics(
  field: string,
  error: TLocalizedValidationError,
  value: Record<string, unknown>
): WikiFormatDiagnostic[] {
  if (field === "title") {
    return [
      {
        code: "frontmatter.invalid-title",
        message: "Page title must be non-empty text",
      },
    ]
  }
  if (field === "created" || field === "updated") {
    return [
      {
        code: "frontmatter.invalid-date",
        message: `${field} must be an ISO date in YYYY-MM-DD format`,
      },
    ]
  }
  if (field === "type") {
    return [
      {
        code: "frontmatter.invalid-type",
        message: `Invalid wiki page type: ${Object.hasOwn(value, "type") ? displayValue(value.type) : "missing"}`,
      },
    ]
  }
  if (field === "tags") {
    return [
      {
        code:
          error.keyword === "uniqueItems"
            ? "frontmatter.duplicate-tag"
            : error.instancePath === ""
              ? "frontmatter.invalid-tags"
              : "frontmatter.invalid-tag",
        message: tagValidationMessage(error, value.tags),
      },
    ]
  }
  if (field === "sources") {
    return [
      {
        code:
          error.instancePath === "" && error.keyword === "minItems"
            ? "frontmatter.missing-source"
            : "frontmatter.invalid-source",
        message: sourceValidationMessage(error, value.sources),
      },
    ]
  }
  return [{ code: "frontmatter.invalid", message: error.message }]
}

function tagValidationMessage(
  error: TLocalizedValidationError,
  value: unknown
): string {
  if (error.keyword === "uniqueItems" && Array.isArray(value)) {
    const duplicate = value[error.params.duplicateItems[0] ?? -1]
    return `Duplicate tag: ${displayValue(duplicate)}`
  }
  if (error.instancePath === "") {
    return "Tags must be a non-empty YAML sequence"
  }
  return `Invalid tag: ${displayValue(valueAtIndex(value, error.instancePath))}`
}

function sourceValidationMessage(
  error: TLocalizedValidationError,
  value: unknown
): string {
  if (error.keyword === "uniqueItems" && Array.isArray(value)) {
    const duplicate = value[error.params.duplicateItems[0] ?? -1]
    return `Duplicate raw source path: ${displayValue(duplicate)}`
  }
  if (error.instancePath === "") {
    return error.keyword === "minItems"
      ? "The page must cite at least one raw source"
      : "Sources must be a non-empty YAML sequence"
  }
  return `Invalid raw source path: ${displayValue(valueAtIndex(value, error.instancePath))}`
}

function valueAtIndex(value: unknown, instancePath: string): unknown {
  if (!Array.isArray(value)) return value
  const index = Number(instancePath.split("/").at(-1))
  return Number.isInteger(index) ? value[index] : value
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return "undefined"
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "number" && !Number.isFinite(value)) return String(value)
  if (typeof value === "symbol") return value.toString()
  if (typeof value === "function")
    return `[function ${value.name || "anonymous"}]`
  try {
    const serialized = JSON.stringify(value, (_key, nestedValue: unknown) =>
      typeof nestedValue === "bigint" ? `${nestedValue}n` : nestedValue
    )
    return serialized
  } catch {
    return Object.prototype.toString.call(value)
  }
}

function isIsoDate(value: string): boolean {
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  )
}

function deduplicateDiagnostics(
  diagnostics: WikiFormatDiagnostic[]
): WikiFormatDiagnostic[] {
  let previous: string | undefined
  return diagnostics.filter(({ code, message }) => {
    const key = `${code}\0${message}`
    if (key === previous) return false
    previous = key
    return true
  })
}

function assertSafeValidationValue(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0
): void {
  if (typeof value !== "object" || value === null) return
  if (depth > 100) throw new Error("Frontmatter nesting is too deep")
  if (ancestors.has(value)) {
    throw new Error("Frontmatter must not contain recursive YAML aliases")
  }
  ancestors.add(value)
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    assertSafeValidationValue(child, ancestors, depth + 1)
  }
  ancestors.delete(value)
}
