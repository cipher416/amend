import { lstat, mkdir, realpath } from "node:fs/promises"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { DatabaseSync } from "node:sqlite"

import {
  parseMarkdownFrontmatter,
  readWikiPageMetadata,
  validateWikiTags,
  wikiPageTypeForPath,
  wikiSourceKindForPath,
} from "../internal/format.ts"
import type { WikiPageType, WikiSourceKind } from "../internal/format.ts"
import {
  git,
  gitRaw,
  validateWikiWorkspace,
} from "../internal/git-workspace.ts"

export type WikiIndexDocumentKind = "page" | "source"
export type WikiIndexSearchScope = "all" | "pages" | "sources"

export interface WikiIndexOptions {
  workspacePath: string
  databasePath: string
}

export interface WikiIndexSearchInput {
  query: string
  scope?: WikiIndexSearchScope
  pageTypes?: readonly WikiPageType[]
  tags?: readonly string[]
  limit?: number
}

export interface WikiIndexHighlight {
  start: number
  end: number
}

export interface WikiIndexSearchResult {
  kind: WikiIndexDocumentKind
  path: string
  title: string
  pageType?: WikiPageType
  sourceKind?: WikiSourceKind
  tags: readonly string[]
  heading?: string
  snippet: string
  highlights: readonly WikiIndexHighlight[]
  score: number
}

export interface WikiIndexTagFacet {
  tag: string
  count: number
}

export interface WikiIndexRefreshResult {
  commitHash: string
  added: number
  updated: number
  removed: number
  unchanged: number
}

export interface WikiIndex {
  readonly workspacePath: string
  readonly databasePath: string
  refresh: () => Promise<WikiIndexRefreshResult>
  search: (
    input: WikiIndexSearchInput
  ) => Promise<readonly WikiIndexSearchResult[]>
  listTags: () => Promise<readonly WikiIndexTagFacet[]>
  close: () => Promise<void>
}

export type WikiIndexErrorCode =
  | "closed"
  | "invalid-database"
  | "invalid-query"
  | "invalid-workspace"
  | "refresh-failed"
  | "unsupported-database"

export class WikiIndexError extends Error {
  readonly code: WikiIndexErrorCode

  constructor(
    code: WikiIndexErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "WikiIndexError"
    this.code = code
  }
}

interface GitDocument {
  path: string
  blobOid: string
  kind: WikiIndexDocumentKind
  pageType?: WikiPageType
  sourceKind?: WikiSourceKind
}

interface IndexedDocument extends GitDocument {
  title: string
  tags: string[]
  sections: Array<{ heading?: string; level?: number; body: string }>
}

interface StoredDocument {
  id: number
  path: string
  blobOid: string
  kind: WikiIndexDocumentKind
}

const applicationId = 1_095_585_348
const schemaVersion = 1
const startHighlight = "\u0001"
const endHighlight = "\u0002"

export async function openWikiIndex(
  options: WikiIndexOptions
): Promise<WikiIndex> {
  const workspacePath = await validateWikiWorkspace(
    options.workspacePath
  ).catch((error: unknown) => {
    throw new WikiIndexError("invalid-workspace", "Invalid wiki workspace", {
      cause: error,
    })
  })
  const requestedDatabasePath = resolve(options.databasePath)
  const prospectiveDatabasePath = await canonicalizeProspectivePath(
    requestedDatabasePath
  )
  if (isInside(workspacePath, prospectiveDatabasePath)) {
    throw new WikiIndexError(
      "invalid-database",
      "Wiki index database must be outside the wiki worktree"
    )
  }
  await mkdir(dirname(requestedDatabasePath), { recursive: true })
  const databasePath = await canonicalizeProspectivePath(requestedDatabasePath)
  if (isInside(workspacePath, databasePath)) {
    throw new WikiIndexError(
      "invalid-database",
      "Wiki index database must be outside the wiki worktree"
    )
  }
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(databasePath)
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
    `)
    migrate(database, workspacePath)
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
    `)
    return new SqliteWikiIndex(workspacePath, databasePath, database)
  } catch (error) {
    try {
      database?.close()
    } catch {
      // Preserve the opening error.
    }
    if (error instanceof WikiIndexError) throw error
    throw new WikiIndexError(
      "unsupported-database",
      `Could not open wiki index database: ${databasePath}`,
      { cause: error }
    )
  }
}

class SqliteWikiIndex implements WikiIndex {
  readonly workspacePath: string
  readonly databasePath: string
  private readonly database: DatabaseSync
  private queue: Promise<void> = Promise.resolve()
  private closePromise: Promise<void> | undefined
  private closing = false
  private closed = false

  constructor(
    workspacePath: string,
    databasePath: string,
    database: DatabaseSync
  ) {
    this.workspacePath = workspacePath
    this.databasePath = databasePath
    this.database = database
  }

  async refresh(): Promise<WikiIndexRefreshResult> {
    return await this.enqueue(async () => await this.refreshSnapshot())
  }

  async search(
    input: WikiIndexSearchInput
  ): Promise<readonly WikiIndexSearchResult[]> {
    return await this.enqueue(() => this.searchDatabase(input))
  }

  async listTags(): Promise<readonly WikiIndexTagFacet[]> {
    return await this.enqueue(() =>
      this.database
        .prepare(
          `SELECT tag, COUNT(*) AS count
           FROM document_tags
           GROUP BY tag
           ORDER BY tag`
        )
        .all()
        .map((row) => ({
          tag: requireString(row.tag, "tag"),
          count: requireNumber(row.count, "count"),
        }))
    )
  }

  async close(): Promise<void> {
    if (this.closed) return
    if (this.closePromise) return await this.closePromise
    this.closing = true
    this.closePromise = this.queue
      .then(() => {
        this.database.close()
        this.closed = true
      })
      .catch((error: unknown) => {
        this.closing = false
        this.closePromise = undefined
        throw error
      })
    return await this.closePromise
  }

  private async enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed || this.closing) {
      throw new WikiIndexError("closed", "Wiki index is closed")
    }
    const result = this.queue.then(operation)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return await result
  }

  private async refreshSnapshot(): Promise<WikiIndexRefreshResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await validateWikiWorkspace(this.workspacePath).catch(
          (error: unknown) => {
            throw new WikiIndexError(
              "invalid-workspace",
              "Wiki workspace is no longer a clean main repository",
              { cause: error }
            )
          }
        )
        if (await git(this.workspacePath, "status", "--porcelain")) {
          throw new WikiIndexError(
            "invalid-workspace",
            "Wiki workspace must be clean before indexing"
          )
        }
        const commitHash = await git(this.workspacePath, "rev-parse", "HEAD")
        const snapshot = await readGitSnapshot(this.workspacePath, commitHash)
        const baselineCommit = readIndexedCommit(this.database)
        const stored = readStoredDocuments(this.database)
        const removed = [...stored.values()].filter(
          ({ path }) => !snapshot.has(path)
        )
        const changed = [...snapshot.values()].filter((document) => {
          const existing = stored.get(document.path)
          return (
            !existing ||
            existing.blobOid !== document.blobOid ||
            existing.kind !== document.kind
          )
        })
        const sourcePaths = new Set(
          [...snapshot.values()]
            .filter(({ kind }) => kind === "source")
            .map(({ path }) => path)
        )
        const documents: IndexedDocument[] = []
        const changedPaths = new Set(changed.map(({ path }) => path))
        const mustRevalidatePages = removed.some(
          ({ kind }) => kind === "source"
        )
        const documentsToParse = mustRevalidatePages
          ? [...snapshot.values()].filter(
              (document) =>
                changedPaths.has(document.path) || document.kind === "page"
            )
          : changed
        for (const document of documentsToParse) {
          const content = await gitRaw(
            this.workspacePath,
            "cat-file",
            "blob",
            document.blobOid
          )
          const extracted = extractDocument(document, content, sourcePaths)
          if (changedPaths.has(document.path)) documents.push(extracted)
        }
        if (
          (await git(this.workspacePath, "rev-parse", "HEAD")) !== commitHash
        ) {
          continue
        }

        writeRefresh(
          this.database,
          this.workspacePath,
          commitHash,
          baselineCommit,
          removed,
          documents
        )
        return {
          commitHash,
          added: changed.filter((document) => !stored.has(document.path))
            .length,
          updated: changed.filter((document) => stored.has(document.path))
            .length,
          removed: removed.length,
          unchanged: snapshot.size - changed.length,
        }
      } catch (error) {
        if (error instanceof StaleIndexError && attempt === 0) continue
        if (error instanceof WikiIndexError) throw error
        throw new WikiIndexError(
          "refresh-failed",
          "Wiki index refresh failed",
          {
            cause: error,
          }
        )
      }
    }
    throw new WikiIndexError(
      "refresh-failed",
      "Wiki HEAD changed repeatedly during indexing"
    )
  }

  private searchDatabase(input: WikiIndexSearchInput): WikiIndexSearchResult[] {
    const expression = compileSearchQuery(input.query)
    const scope = input.scope ?? "all"
    if (!(["all", "pages", "sources"] as const).includes(scope)) {
      throw new WikiIndexError("invalid-query", "Invalid wiki search scope")
    }
    const pageTypes = [...new Set(input.pageTypes ?? [])]
    if (pageTypes.some((type) => !isWikiPageType(type))) {
      throw new WikiIndexError("invalid-query", "Invalid wiki page type filter")
    }
    const tags = [...new Set(input.tags ?? [])]
    if (tags.length > 0) {
      const validation = validateWikiTags(tags)
      if (validation.errors.length > 0) {
        throw new WikiIndexError("invalid-query", validation.errors.join("; "))
      }
    }
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new WikiIndexError(
        "invalid-query",
        "Wiki search limit must be an integer from 1 through 100"
      )
    }

    const conditions = ["document_fts MATCH ?"]
    const parameters: Array<string | number> = [expression]
    if (scope !== "all") {
      conditions.push("documents.kind = ?")
      parameters.push(scope === "pages" ? "page" : "source")
    }
    if (pageTypes.length > 0) {
      conditions.push(
        `documents.page_type IN (${pageTypes.map(() => "?").join(", ")})`
      )
      parameters.push(...pageTypes)
    }
    for (const tag of tags) {
      conditions.push(`EXISTS (
        SELECT 1 FROM document_tags
        WHERE document_tags.document_id = documents.id
          AND document_tags.tag = ?
      )`)
      parameters.push(tag)
    }
    parameters.push(limit)
    const rows = this.database
      .prepare(
        `SELECT
           documents.id,
           documents.kind,
           documents.path,
           documents.title,
           documents.page_type AS pageType,
           documents.source_kind AS sourceKind,
           documents.tags_json AS tagsJson,
           snippet(document_fts, -1, '${startHighlight}', '${endHighlight}', ' … ', 28) AS snippet,
           bm25(document_fts, 8.0, 3.0, 1.0) AS rank
         FROM document_fts
         JOIN documents ON documents.id = document_fts.rowid
         WHERE ${conditions.join(" AND ")}
         ORDER BY rank ASC, documents.path ASC
         LIMIT ?`
      )
      .all(...parameters)

    const findSection = this.database.prepare(
      `SELECT
         sections.heading,
         snippet(section_fts, -1, '${startHighlight}', '${endHighlight}', ' … ', 28) AS snippet
       FROM section_fts
       JOIN sections ON sections.id = section_fts.rowid
       WHERE sections.document_id = ? AND section_fts MATCH ?
       ORDER BY bm25(section_fts, 8.0, 4.0, 3.0, 1.0) ASC, sections.ordinal ASC
       LIMIT 1`
    )
    const results: WikiIndexSearchResult[] = []
    for (const row of rows) {
      const path = requireString(row.path, "path")
      const section = findSection.get(requireNumber(row.id, "id"), expression)
      const markedSnippet = requireString(
        section?.snippet ?? row.snippet,
        "snippet"
      )
      const parsedSnippet = parseHighlights(markedSnippet)
      const pageType = optionalString(row.pageType)
      const sourceKind = optionalString(row.sourceKind)
      results.push({
        kind: requireDocumentKind(row.kind),
        path,
        title: requireString(row.title, "title"),
        ...(pageType ? { pageType: requirePageType(pageType) } : {}),
        ...(sourceKind ? { sourceKind: requireSourceKind(sourceKind) } : {}),
        tags: parseTagsJson(requireString(row.tagsJson, "tagsJson")),
        ...(optionalString(section?.heading)
          ? { heading: optionalString(section?.heading) }
          : {}),
        snippet: parsedSnippet.text,
        highlights: parsedSnippet.highlights,
        score: -requireNumber(row.rank, "rank"),
      })
    }
    return results
  }
}

function migrate(database: DatabaseSync, workspacePath: string): void {
  const currentApplicationId = requireNumber(
    database.prepare("PRAGMA application_id").get()?.application_id,
    "application_id"
  )
  const currentVersion = requireNumber(
    database.prepare("PRAGMA user_version").get()?.user_version,
    "user_version"
  )
  if (currentApplicationId !== 0 && currentApplicationId !== applicationId) {
    throw new WikiIndexError(
      "invalid-database",
      "Database is owned by another application"
    )
  }
  if (currentVersion > schemaVersion) {
    throw new WikiIndexError(
      "invalid-database",
      "Wiki index schema is newer than this version of Amend"
    )
  }
  if (currentApplicationId === 0 && currentVersion !== 0) {
    throw new WikiIndexError(
      "invalid-database",
      "Database is not an Amend wiki index"
    )
  }

  if (currentVersion === 0) {
    transaction(database, () => {
      const lockedApplicationId = requireNumber(
        database.prepare("PRAGMA application_id").get()?.application_id,
        "application_id"
      )
      const lockedVersion = requireNumber(
        database.prepare("PRAGMA user_version").get()?.user_version,
        "user_version"
      )
      if (lockedVersion !== 0) {
        if (lockedApplicationId !== applicationId) {
          throw new WikiIndexError(
            "invalid-database",
            "Database is owned by another application"
          )
        }
        return
      }
      const objectCount = requireNumber(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'"
          )
          .get()?.count,
        "schema object count"
      )
      if (lockedApplicationId !== 0 || objectCount !== 0) {
        throw new WikiIndexError(
          "invalid-database",
          "Database is not an empty Amend wiki index"
        )
      }
      database.exec(`
        CREATE TABLE index_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          workspace_path TEXT NOT NULL,
          indexed_commit TEXT,
          indexed_at TEXT
        ) STRICT;

        CREATE TABLE documents (
          id INTEGER PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK (kind IN ('page', 'source')),
          page_type TEXT,
          source_kind TEXT,
          blob_oid TEXT NOT NULL,
          title TEXT NOT NULL,
          tags_json TEXT NOT NULL
        ) STRICT;

        CREATE TABLE document_tags (
          document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          tag TEXT NOT NULL,
          PRIMARY KEY (document_id, tag)
        ) STRICT;

        CREATE INDEX document_tags_by_tag ON document_tags(tag, document_id);

        CREATE TABLE sections (
          id INTEGER PRIMARY KEY,
          document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          heading TEXT,
          UNIQUE (document_id, ordinal)
        ) STRICT;

        CREATE VIRTUAL TABLE document_fts USING fts5(
          title,
          tags,
          body,
          tokenize = 'unicode61 remove_diacritics 2'
        );

        CREATE VIRTUAL TABLE section_fts USING fts5(
          title,
          heading,
          tags,
          body,
          tokenize = 'unicode61 remove_diacritics 2'
        );

        PRAGMA application_id = ${applicationId};
        PRAGMA user_version = ${schemaVersion};
      `)
      database
        .prepare(
          "INSERT INTO index_metadata(singleton, workspace_path) VALUES (1, ?)"
        )
        .run(workspacePath)
    })
  }

  const metadata = database
    .prepare("SELECT workspace_path FROM index_metadata WHERE singleton = 1")
    .get()
  if (!metadata) {
    throw new WikiIndexError(
      "invalid-database",
      "Wiki index database has no workspace owner"
    )
  }
  if (
    requireString(metadata.workspace_path, "workspace_path") !== workspacePath
  ) {
    throw new WikiIndexError(
      "invalid-database",
      "Wiki index database belongs to another workspace"
    )
  }
}

async function readGitSnapshot(
  workspacePath: string,
  commitHash: string
): Promise<Map<string, GitDocument>> {
  const output = await gitRaw(
    workspacePath,
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    commitHash
  )
  const documents = new Map<string, GitDocument>()
  for (const record of output.split("\0")) {
    if (!record) continue
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(record)
    if (!match) continue
    const blobOid = match[1]
    const path = match[2]
    if (!blobOid || !path) continue
    const pageType = wikiPageTypeForPath(path)
    if (pageType) {
      documents.set(path, { path, blobOid, kind: "page", pageType })
      continue
    }
    const sourceKind = wikiSourceKindForPath(path)
    if (sourceKind) {
      documents.set(path, { path, blobOid, kind: "source", sourceKind })
    }
  }
  return documents
}

function readStoredDocuments(
  database: DatabaseSync
): Map<string, StoredDocument> {
  return new Map(
    database
      .prepare("SELECT id, path, blob_oid AS blobOid, kind FROM documents")
      .all()
      .map((row) => {
        const path = requireString(row.path, "path")
        return [
          path,
          {
            id: requireNumber(row.id, "id"),
            path,
            blobOid: requireString(row.blobOid, "blobOid"),
            kind: requireDocumentKind(row.kind),
          },
        ] as const
      })
  )
}

function extractDocument(
  document: GitDocument,
  content: string,
  availableSourcePaths: ReadonlySet<string>
): IndexedDocument {
  if (Buffer.byteLength(content, "utf8") > 5_500_000) {
    throw new Error(`Wiki document is too large to index: ${document.path}`)
  }
  const { frontmatter, body } = parseMarkdownFrontmatter(content, document.path)
  const sections = splitMarkdownSections(body)

  if (document.kind === "page") {
    const metadata = readWikiPageMetadata(frontmatter, document.path)
    for (const sourcePath of metadata.sourcePaths) {
      if (!availableSourcePaths.has(sourcePath)) {
        metadata.diagnostics.push({
          code: "frontmatter.missing-source",
          message: `Cited raw source does not exist: ${sourcePath}`,
        })
      }
    }
    if (
      metadata.diagnostics.length > 0 ||
      !metadata.title ||
      !metadata.pageType
    ) {
      throw new Error(
        `${document.path}: ${metadata.diagnostics.map(({ message }) => message).join("; ")}`
      )
    }
    return {
      ...document,
      title: metadata.title,
      pageType: metadata.pageType,
      tags: metadata.tags,
      sections,
    }
  }

  const heading = sections.find(
    (section) => section.level === 1 && section.heading
  )?.heading
  const sourceTitle = frontmatter.get("title")
  return {
    ...document,
    title:
      typeof sourceTitle === "string" && sourceTitle.trim()
        ? sourceTitle.trim()
        : (heading ?? titleFromPath(document.path)),
    tags: [],
    sections,
  }
}

function splitMarkdownSections(
  body: string
): Array<{ heading?: string; level?: number; body: string }> {
  const sections: Array<{ heading?: string; level?: number; body: string }> = []
  let heading: string | undefined
  let level: number | undefined
  let lines: string[] = []
  let fence: { marker: "`" | "~"; length: number } | undefined

  const flush = () => {
    const sectionBody = lines.join("\n").trim()
    if (sectionBody || heading) {
      sections.push({
        ...(heading ? { heading } : {}),
        ...(level ? { level } : {}),
        body: sectionBody,
      })
    }
    lines = []
  }

  for (const line of body.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~"
      if (!fence) fence = { marker, length: fenceMatch[1].length }
      else if (
        fence.marker === marker &&
        fenceMatch[1].length >= fence.length &&
        /^\s*$/.test(line.slice(fenceMatch[0].length))
      ) {
        fence = undefined
      }
      lines.push(line)
      continue
    }
    const headingMatch = fence
      ? undefined
      : /^ {0,3}(#{1,6})[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/.exec(line)
    if (headingMatch) {
      flush()
      heading = headingMatch[2].trim()
      level = headingMatch[1].length
      continue
    }
    const setextMatch = fence ? undefined : /^ {0,3}(=+|-+)\s*$/.exec(line)
    if (setextMatch && lines.length > 0) {
      const setextHeading = lines.pop()?.trim()
      if (setextHeading) {
        flush()
        heading = setextHeading
        level = setextMatch[1][0] === "=" ? 1 : 2
        continue
      }
    }
    lines.push(line)
  }
  flush()
  if (sections.length === 0) return [{ body: body.trim() }]
  return sections
}

function titleFromPath(path: string): string {
  const slug = basename(path, ".md")
  return slug
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

function writeRefresh(
  database: DatabaseSync,
  workspacePath: string,
  commitHash: string,
  baselineCommit: string | undefined,
  removed: StoredDocument[],
  changed: IndexedDocument[]
): void {
  transaction(database, () => {
    if (readIndexedCommit(database) !== baselineCommit) {
      throw new StaleIndexError()
    }
    const deleteFts = database.prepare(
      "DELETE FROM section_fts WHERE rowid IN (SELECT id FROM sections WHERE document_id = ?)"
    )
    const deleteDocumentFts = database.prepare(
      "DELETE FROM document_fts WHERE rowid = ?"
    )
    const deleteDocument = database.prepare(
      "DELETE FROM documents WHERE id = ?"
    )
    const findDocument = database.prepare(
      "SELECT id FROM documents WHERE path = ?"
    )
    const insertDocument = database.prepare(
      `INSERT INTO documents(path, kind, page_type, source_kind, blob_oid, title, tags_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const updateDocument = database.prepare(
      `UPDATE documents
       SET kind = ?, page_type = ?, source_kind = ?, blob_oid = ?, title = ?, tags_json = ?
       WHERE id = ?`
    )
    const insertTag = database.prepare(
      "INSERT INTO document_tags(document_id, tag) VALUES (?, ?)"
    )
    const insertSection = database.prepare(
      "INSERT INTO sections(document_id, ordinal, heading) VALUES (?, ?, ?)"
    )
    const insertFts = database.prepare(
      "INSERT INTO section_fts(rowid, title, heading, tags, body) VALUES (?, ?, ?, ?, ?)"
    )
    const insertDocumentFts = database.prepare(
      "INSERT INTO document_fts(rowid, title, tags, body) VALUES (?, ?, ?, ?)"
    )

    for (const document of removed) {
      deleteFts.run(document.id)
      deleteDocumentFts.run(document.id)
      deleteDocument.run(document.id)
    }
    for (const document of changed) {
      const existing = findDocument.get(document.path)
      let documentId: number
      if (existing) {
        documentId = requireNumber(existing.id, "id")
        deleteFts.run(documentId)
        deleteDocumentFts.run(documentId)
        database
          .prepare("DELETE FROM sections WHERE document_id = ?")
          .run(documentId)
        database
          .prepare("DELETE FROM document_tags WHERE document_id = ?")
          .run(documentId)
        updateDocument.run(
          document.kind,
          document.pageType ?? null,
          document.sourceKind ?? null,
          document.blobOid,
          document.title,
          JSON.stringify(document.tags),
          documentId
        )
      } else {
        const result = insertDocument.run(
          document.path,
          document.kind,
          document.pageType ?? null,
          document.sourceKind ?? null,
          document.blobOid,
          document.title,
          JSON.stringify(document.tags)
        )
        documentId = Number(result.lastInsertRowid)
      }
      for (const tag of document.tags) insertTag.run(documentId, tag)
      const fullBody: string[] = []
      for (const [ordinal, section] of document.sections.entries()) {
        const heading = section.heading
          ? markdownToPlainText(section.heading)
          : undefined
        const body = markdownToPlainText(section.body)
        const result = insertSection.run(documentId, ordinal, heading ?? null)
        insertFts.run(
          Number(result.lastInsertRowid),
          ordinal === 0 ? markdownToPlainText(document.title) : "",
          heading ?? "",
          ordinal === 0 ? document.tags.join(" ") : "",
          body
        )
        fullBody.push([heading, body].filter(Boolean).join("\n"))
      }
      insertDocumentFts.run(
        documentId,
        markdownToPlainText(document.title),
        document.tags.join(" "),
        fullBody.join("\n\n")
      )
    }
    database
      .prepare(
        `UPDATE index_metadata
         SET workspace_path = ?, indexed_commit = ?, indexed_at = ?
         WHERE singleton = 1`
      )
      .run(workspacePath, commitHash, new Date().toISOString())
  })
}

function readIndexedCommit(database: DatabaseSync): string | undefined {
  return optionalString(
    database
      .prepare("SELECT indexed_commit FROM index_metadata WHERE singleton = 1")
      .get()?.indexed_commit
  )
}

function transaction(database: DatabaseSync, operation: () => void): void {
  database.exec("BEGIN IMMEDIATE")
  try {
    operation()
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

function compileSearchQuery(query: string): string {
  const normalized = query.normalize("NFKC").trim()
  if (!normalized || normalized.length > 256) {
    throw new WikiIndexError(
      "invalid-query",
      "Wiki search query must contain 1 through 256 characters"
    )
  }
  const terms = normalized.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? []
  if (terms.length === 0 || terms.length > 24) {
    throw new WikiIndexError(
      "invalid-query",
      "Wiki search query must contain 1 through 24 searchable terms"
    )
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ")
}

function markdownToPlainText(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\s*(?:`{3,}|~{3,}).*$/gm, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*(?:>|[-+*]|\d+\.)\s+/gm, "")
    .replace(/[`*~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function parseHighlights(value: string): {
  text: string
  highlights: WikiIndexHighlight[]
} {
  let text = ""
  let highlightStart: number | undefined
  const highlights: WikiIndexHighlight[] = []
  for (const character of value) {
    if (character === startHighlight) {
      highlightStart = text.length
    } else if (character === endHighlight) {
      if (highlightStart !== undefined && highlightStart < text.length) {
        highlights.push({ start: highlightStart, end: text.length })
      }
      highlightStart = undefined
    } else {
      text += character
    }
  }
  return { text, highlights }
}

function parseTagsJson(value: string): string[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== "string")) {
    throw new Error("Wiki index contains invalid tags")
  }
  return parsed as string[]
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  )
}

async function canonicalizeProspectivePath(path: string): Promise<string> {
  const missingParts: string[] = []
  let existingPath = path
  for (;;) {
    try {
      return join(await realpath(existingPath), ...missingParts)
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error
      const entry = await lstat(existingPath).catch((statError: unknown) => {
        if (isNodeError(statError) && statError.code === "ENOENT")
          return undefined
        throw statError
      })
      if (entry?.isSymbolicLink()) {
        throw new WikiIndexError(
          "invalid-database",
          "Wiki index database path contains a dangling symbolic link"
        )
      }
      const parent = dirname(existingPath)
      if (parent === existingPath) throw error
      missingParts.unshift(basename(existingPath))
      existingPath = parent
    }
  }
}

function isWikiPageType(value: unknown): value is WikiPageType {
  return ["entity", "concept", "comparison", "query"].includes(value as string)
}

function requireDocumentKind(value: unknown): WikiIndexDocumentKind {
  if (value !== "page" && value !== "source") {
    throw new Error("Wiki index contains an invalid document kind")
  }
  return value
}

function requirePageType(value: string): WikiPageType {
  if (!isWikiPageType(value))
    throw new Error("Wiki index contains an invalid page type")
  return value
}

function requireSourceKind(value: string): WikiSourceKind {
  if (
    !(["article", "paper", "transcript"] as const).includes(
      value as WikiSourceKind
    )
  ) {
    throw new Error("Wiki index contains an invalid source kind")
  }
  return value as WikiSourceKind
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string")
    throw new Error(`Wiki index has invalid ${name}`)
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number")
    throw new Error(`Wiki index has invalid ${name}`)
  return value
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

class StaleIndexError extends Error {}
