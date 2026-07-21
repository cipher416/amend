import { readFile, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"

import { git } from "./internal/git.ts"
import { isWikiManifest } from "./internal/wiki-manifest.ts"
import type { WikiManifest } from "./internal/wiki-manifest.ts"

export interface Wiki {
  id: string
  domain: string
  setupStatus: "initialized" | "ready"
}

const manifestRelativePath = ".amend/wiki.json"

export async function readWiki(input: { wikiPath: string }): Promise<Wiki> {
  const wikiPath = await resolveWikiPath(input)
  const manifest = parseWikiManifest(
    await readManifest(join(wikiPath, manifestRelativePath))
  )
  return {
    id: manifest.id,
    domain: manifest.domain,
    setupStatus: await readSetupStatus(wikiPath),
  }
}

export async function resolveWikiPath(input: {
  wikiPath: string
}): Promise<string> {
  return await validateGitWiki(input.wikiPath)
}

async function readSetupStatus(wikiPath: string): Promise<Wiki["setupStatus"]> {
  const committedRunPaths = await git(
    wikiPath,
    "ls-tree",
    "-r",
    "--name-only",
    "HEAD",
    "--",
    ".amend/runs"
  )
  return committedRunPaths
    .split("\n")
    .some((path) => /^\.amend\/runs\/[^/]+\.json$/.test(path))
    ? "ready"
    : "initialized"
}

async function validateGitWiki(wikiPathInput: string): Promise<string> {
  const wikiPath = await realpath(resolve(wikiPathInput))
  const gitRoot = await realpath(
    await git(wikiPath, "rev-parse", "--show-toplevel")
  )
  if (gitRoot !== wikiPath) {
    throw new Error("Wiki must be the Git repository root")
  }
  if ((await git(wikiPath, "symbolic-ref", "HEAD")) !== "refs/heads/main") {
    throw new Error("Wiki must use the main branch")
  }
  return wikiPath
}

async function readManifest(manifestPath: string): Promise<string> {
  try {
    return await readFile(manifestPath, "utf8")
  } catch (error) {
    throw new Error("Invalid wiki manifest", { cause: error })
  }
}

function parseWikiManifest(content: string): WikiManifest {
  const value = parseJsonObject(content)
  if (!isWikiManifest(value)) {
    throw new Error("Invalid wiki manifest")
  }
  return value
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(content)
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // Fall through to the stable public validation error.
  }
  throw new Error("Invalid wiki manifest")
}
