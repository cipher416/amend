import { execFile } from "node:child_process"
import { readFile, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"

export async function validateWikiWorkspace(
  workspacePathInput: string
): Promise<string> {
  const workspacePath = await realpath(resolve(workspacePathInput))
  const record = JSON.parse(
    await readFile(join(workspacePath, ".amend/workspace.json"), "utf8")
  ) as { version?: unknown }
  if (record.version !== 1) throw new Error("Unsupported wiki workspace")
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

export async function git(
  cwd: string,
  ...arguments_: string[]
): Promise<string> {
  return (await executeGit(cwd, arguments_)).trim()
}

export async function gitRaw(
  cwd: string,
  ...arguments_: string[]
): Promise<string> {
  return await executeGit(cwd, arguments_)
}

async function executeGit(cwd: string, arguments_: string[]): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["-C", cwd, ...arguments_],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(stderr.trim() || error.message, { cause: error })
          )
          return
        }
        resolvePromise(stdout)
      }
    )
  })
}
