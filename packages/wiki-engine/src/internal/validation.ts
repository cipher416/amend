import { readFile, readdir } from "node:fs/promises"
import { basename, join } from "node:path"

import {
  parseMarkdownFrontmatter,
  readWikiPageMetadata,
  wikiPageDirectories,
} from "./format.ts"

export interface WikiValidationDiagnostic {
  code: string
  message: string
  path?: string
}

export async function lintWikiStructure(
  wikiPath: string
): Promise<WikiValidationDiagnostic[]> {
  const diagnostics: WikiValidationDiagnostic[] = []
  const pages = await readWikiPages(wikiPath)
  if (pages.length === 0) {
    diagnostics.push({
      code: "page.missing",
      message: "The wiki must contain at least one page",
    })
  }
  const index = await readFile(join(wikiPath, "index.md"), "utf8").catch(
    () => undefined
  )
  if (index === undefined) {
    diagnostics.push({
      code: "index.missing",
      path: "index.md",
      message: "The wiki index is missing",
    })
  }

  const pathsByPageName = new Map<string, string[]>()
  for (const page of pages) {
    const pageName = basename(page.path, ".md")
    const paths = pathsByPageName.get(pageName) ?? []
    paths.push(page.path)
    pathsByPageName.set(pageName, paths)
  }
  for (const [pageName, paths] of pathsByPageName) {
    if (paths.length > 1) {
      diagnostics.push({
        code: "page.duplicate-slug",
        message: `Page slug ${pageName} is duplicated by ${paths.join(", ")}`,
      })
    }
  }

  const pageNames = new Set(pathsByPageName.keys())
  for (const page of pages) {
    diagnostics.push(...(await lintPage(page.path, page.content, wikiPath)))
    const pageName = basename(page.path, ".md")
    if (index !== undefined && !index.includes(`[[${pageName}]]`)) {
      diagnostics.push({
        code: "index.missing-page",
        path: "index.md",
        message: `The index is missing wiki page ${pageName}`,
      })
    }
    diagnostics.push(...lintWikilinks(page.path, page.content, pageNames))
  }
  if (index !== undefined) {
    diagnostics.push(...lintWikilinks("index.md", index, pageNames))
  }
  return diagnostics
}

function lintWikilinks(
  path: string,
  content: string,
  pageNames: ReadonlySet<string>
): WikiValidationDiagnostic[] {
  const diagnostics: WikiValidationDiagnostic[] = []
  for (const link of content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    const target = link[1].trim()
    if (target && !pageNames.has(target)) {
      diagnostics.push({
        code: "wikilink.broken",
        path,
        message: `Wikilink target does not exist: ${target}`,
      })
    }
  }
  return diagnostics
}

export async function readFilesUnder(
  rootPath: string
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  async function visit(currentPath: string, relativePath: string) {
    for (const entry of await readdir(currentPath, { withFileTypes: true })) {
      const childRelative = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name
      const childPath = join(currentPath, entry.name)
      if (entry.isDirectory()) await visit(childPath, childRelative)
      else if (entry.isFile()) {
        result.set(childRelative, await readFile(childPath, "utf8"))
      }
    }
  }
  try {
    await visit(rootPath, "")
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error
  }
  return result
}

async function readWikiPages(wikiPath: string) {
  const pages: Array<{ path: string; content: string }> = []
  for (const directory of wikiPageDirectories) {
    const files = await readFilesUnder(join(wikiPath, directory))
    for (const [path, content] of files) {
      if (path.endsWith(".md")) {
        pages.push({ path: `${directory}/${path}`, content })
      }
    }
  }
  return pages
}

async function lintPage(
  pagePath: string,
  content: string,
  wikiPath: string
): Promise<WikiValidationDiagnostic[]> {
  let frontmatter: Map<string, unknown>
  try {
    frontmatter = parseMarkdownFrontmatter(content, pagePath).frontmatter
  } catch (error) {
    return [
      {
        code: "frontmatter.invalid",
        path: pagePath,
        message: error instanceof Error ? error.message : "Invalid frontmatter",
      },
    ]
  }
  const metadata = readWikiPageMetadata(frontmatter, pagePath)
  const diagnostics: WikiValidationDiagnostic[] = metadata.diagnostics.map(
    (diagnostic) => ({ ...diagnostic, path: pagePath })
  )
  for (const sourcePath of metadata.sourcePaths) {
    const exists = await readFile(
      join(wikiPath, ...sourcePath.split("/")),
      "utf8"
    )
      .then(() => true)
      .catch(() => false)
    if (!exists) {
      diagnostics.push({
        code: "frontmatter.missing-source",
        path: pagePath,
        message: `Cited raw source does not exist: ${sourcePath}`,
      })
    }
  }
  return diagnostics
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
