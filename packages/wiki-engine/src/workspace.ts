import { randomUUID } from "node:crypto"
import { readFile, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { git } from "./internal/git.ts"
import {
  isWorkspaceManifest,
  validateWorkspaceId,
} from "./internal/workspace-manifest.ts"
import type { WorkspaceManifest } from "./internal/workspace-manifest.ts"

export interface WikiWorkspace {
  id: string
  domain: string
  setupStatus: "initialized" | "ready"
}

interface WorkspaceManifestV1 {
  version: 1
  domain: string
}

const manifestRelativePath = ".amend/workspace.json"

export async function readWorkspace(input: {
  workspacePath: string
}): Promise<WikiWorkspace> {
  const workspacePath = await resolveWorkspacePath(input)
  const manifest = parseWorkspaceManifest(
    await readManifest(join(workspacePath, manifestRelativePath))
  )
  return {
    id: manifest.id,
    domain: manifest.domain,
    setupStatus: await readSetupStatus(workspacePath),
  }
}

export async function migrateWorkspace(input: {
  workspacePath: string
  createWorkspaceId?: () => string
}): Promise<WikiWorkspace> {
  const workspacePath = await resolveWorkspacePath(input)
  const manifestPath = join(workspacePath, manifestRelativePath)
  const originalManifest = await readManifest(manifestPath)
  const legacy = parseWorkspaceManifestV1(originalManifest)
  if (await git(workspacePath, "status", "--porcelain")) {
    throw new Error("Wiki workspace must be clean before migration")
  }

  const id = validateWorkspaceId((input.createWorkspaceId ?? randomUUID)())
  const migratedManifest = `${JSON.stringify(
    {
    version: 2,
    id,
    domain: legacy.domain,
    },
    null,
    2
  )}\n`

  try {
    await writeFile(manifestPath, migratedManifest)
    await git(workspacePath, "add", "--", manifestRelativePath)
    await git(workspacePath, "commit", "-m", "Migrate workspace metadata")
  } catch (error) {
    try {
      await writeFile(manifestPath, originalManifest)
      await git(workspacePath, "add", "--", manifestRelativePath)
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Workspace metadata migration failed and the manifest could not be restored"
      )
    }
    throw error
  }

  return {
    id,
    domain: legacy.domain,
    setupStatus: await readSetupStatus(workspacePath),
  }
}

export async function resolveWorkspacePath(input: {
  workspacePath: string
}): Promise<string> {
  return await validateGitWorkspace(input.workspacePath)
}

async function readSetupStatus(
  workspacePath: string
): Promise<WikiWorkspace["setupStatus"]> {
  const committedRunPaths = await git(
    workspacePath,
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

async function validateGitWorkspace(
  workspacePathInput: string
): Promise<string> {
  const workspacePath = await realpath(resolve(workspacePathInput))
  const gitRoot = await realpath(
    await git(workspacePath, "rev-parse", "--show-toplevel")
  )
  if (gitRoot !== workspacePath) {
    throw new Error("Wiki workspace must be the Git repository root")
  }
  if (
    (await git(workspacePath, "symbolic-ref", "HEAD")) !== "refs/heads/main"
  ) {
    throw new Error("Wiki workspace must use the main branch")
  }
  return workspacePath
}

async function readManifest(manifestPath: string): Promise<string> {
  try {
    return await readFile(manifestPath, "utf8")
  } catch (error) {
    throw new Error("Invalid wiki workspace manifest", { cause: error })
  }
}

function parseWorkspaceManifestV1(content: string): WorkspaceManifestV1 {
  const value = parseJsonObject(content)
  if (
    !hasExactKeys(value, ["domain", "version"]) ||
    value.version !== 1 ||
    !isValidDomain(value.domain)
  ) {
    throw new Error("Invalid legacy wiki workspace manifest")
  }
  return { version: 1, domain: value.domain }
}

function parseWorkspaceManifest(content: string): WorkspaceManifest {
  const value = parseJsonObject(content)
  if (!isWorkspaceManifest(value)) {
    throw new Error("Invalid wiki workspace manifest")
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
  throw new Error("Invalid wiki workspace manifest")
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value).sort()
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  )
}

function isValidDomain(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim()
}
