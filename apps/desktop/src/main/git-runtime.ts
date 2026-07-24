import { configureGitRuntime } from "@workspace/wiki-engine/git-runtime"
import type { GitRuntime } from "@workspace/wiki-engine/git-runtime"
import path from "node:path"

export function configureDesktopGitRuntime(options: {
  isPackaged: boolean
  resourcesPath: string
}): void {
  if (!options.isPackaged) return

  configureGitRuntime(resolveBundledGitRuntime(options.resourcesPath))
}

export function resolveBundledGitRuntime(
  resourcesPath: string,
  options: {
    architecture?: NodeJS.Architecture
    environment?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
  } = {}
): GitRuntime {
  const architecture = options.architecture ?? process.arch
  const platform = options.platform ?? process.platform
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const gitDirectory = pathApi.join(resourcesPath, "git")
  const environment = { ...(options.environment ?? process.env) }

  if (platform === "win32") {
    const platformDirectory =
      architecture === "x64"
        ? "mingw64"
        : architecture === "arm64"
          ? "clangarm64"
          : "mingw32"
    environment.PATH = [
      pathApi.join(gitDirectory, platformDirectory, "bin"),
      pathApi.join(gitDirectory, platformDirectory, "usr", "bin"),
      environment.PATH ?? "",
    ].join(pathApi.delimiter)
    environment.GIT_EXEC_PATH = pathApi.join(
      gitDirectory,
      platformDirectory,
      "libexec",
      "git-core"
    )

    return {
      executable: pathApi.join(gitDirectory, "cmd", "git.exe"),
      environment,
    }
  }

  environment.GIT_CONFIG_SYSTEM = pathApi.join(gitDirectory, "etc", "gitconfig")
  environment.GIT_EXEC_PATH = pathApi.join(gitDirectory, "libexec", "git-core")
  environment.GIT_TEMPLATE_DIR = pathApi.join(
    gitDirectory,
    "share",
    "git-core",
    "templates"
  )

  if (platform === "linux") {
    environment.GIT_SSL_CAINFO = pathApi.join(gitDirectory, "ssl", "cacert.pem")
    environment.PREFIX = gitDirectory
  }

  return {
    executable: pathApi.join(gitDirectory, "bin", "git"),
    environment,
  }
}
