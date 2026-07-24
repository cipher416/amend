import { execFile } from "node:child_process"

export interface GitRuntime {
  executable: string
  environment?: NodeJS.ProcessEnv
}

const systemGitRuntime: GitRuntime = { executable: "git" }
let gitRuntime = systemGitRuntime

export function configureGitRuntime(runtime: GitRuntime): () => void {
  const previousRuntime = gitRuntime
  gitRuntime = runtime
  return () => {
    gitRuntime = previousRuntime
  }
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
  const runtime = gitRuntime
  return await new Promise((resolvePromise, rejectPromise) => {
    execFile(
      runtime.executable,
      ["-C", cwd, ...arguments_],
      {
        encoding: "utf8",
        env: runtime.environment,
        maxBuffer: 20 * 1024 * 1024,
      },
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
