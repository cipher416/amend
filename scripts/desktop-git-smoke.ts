import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { resolveBundledGitRuntime } from "../apps/desktop/src/main/git-runtime.ts"

void main()

async function main(): Promise<void> {
  const executeFile = promisify(execFile)
  const packageRoot = path.resolve(process.argv[2] ?? "apps/desktop/out")
  const gitDirectory = await findPackagedGit(packageRoot, packageRoot)
  const runtime = resolveBundledGitRuntime(path.dirname(gitDirectory))
  const environment = runtime.environment
  assert.ok(environment)
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "amend-packaged-git-")
  )
  const repositoryPath = path.join(temporaryRoot, "wiki")
  const worktreePath = path.join(temporaryRoot, "worktree")

  const run = async (arguments_: string[]): Promise<string> => {
    const result = await executeFile(runtime.executable, arguments_, {
      encoding: "utf8",
      env: environment,
      maxBuffer: 20 * 1024 * 1024,
    })
    return result.stdout
  }

  try {
    const version = await run(["--version"])
    await run(["init", "--initial-branch=main", repositoryPath])
    await run(["-C", repositoryPath, "config", "user.name", "Amend Smoke"])
    await run([
      "-C",
      repositoryPath,
      "config",
      "user.email",
      "smoke@example.invalid",
    ])
    await run(["-C", repositoryPath, "config", "commit.gpgsign", "false"])
    await writeFile(path.join(repositoryPath, "README.md"), "seed\n")
    await run(["-C", repositoryPath, "add", "--all"])
    await run(["-C", repositoryPath, "commit", "-m", "Seed smoke repository"])
    await run([
      "-C",
      repositoryPath,
      "worktree",
      "add",
      "-b",
      "smoke",
      worktreePath,
    ])
    await writeFile(path.join(worktreePath, "README.md"), "changed\n")
    const difference = await run([
      "-C",
      worktreePath,
      "diff",
      "--no-color",
      "--",
      "README.md",
    ])
    if (!difference.includes("-seed") || !difference.includes("+changed")) {
      throw new Error("Packaged Git produced an unexpected diff")
    }
    await run([
      "-C",
      repositoryPath,
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ])

    console.log(
      JSON.stringify({
        git: version.trim(),
        path: runtime.executable,
        smoke: "passed",
      })
    )
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true })
  }
}

async function findPackagedGit(
  directory: string,
  packageRoot: string,
  depth = 0
): Promise<string> {
  if (depth > 8) {
    throw new Error(`Could not find packaged Git under ${packageRoot}`)
  }

  for (const resourceName of ["resources", "Resources"]) {
    const candidate = path.join(directory, resourceName, "git")
    try {
      await access(candidate)
      return candidate
    } catch {
      // Continue searching packaged application directories.
    }
  }

  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      return await findPackagedGit(
        path.join(directory, entry.name),
        packageRoot,
        depth + 1
      )
    } catch {
      // Try the next directory.
    }
  }

  throw new Error(`Could not find packaged Git under ${directory}`)
}
