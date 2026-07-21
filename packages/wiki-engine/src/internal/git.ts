import { execFile } from "node:child_process"

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
