import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { resolveBundledGitRuntime } from "./git-runtime.ts"

describe("bundled Git runtime", () => {
  it("resolves the Linux executable and support paths", () => {
    const runtime = resolveBundledGitRuntime("/app/resources", {
      environment: { PATH: "/usr/bin" },
      platform: "linux",
    })
    const environment = runtime.environment
    assert.ok(environment)

    assert.equal(runtime.executable, "/app/resources/git/bin/git")
    assert.equal(
      environment.GIT_EXEC_PATH,
      "/app/resources/git/libexec/git-core"
    )
    assert.equal(
      environment.GIT_TEMPLATE_DIR,
      "/app/resources/git/share/git-core/templates"
    )
    assert.equal(environment.PREFIX, "/app/resources/git")
    assert.equal(
      environment.GIT_SSL_CAINFO,
      "/app/resources/git/ssl/cacert.pem"
    )
  })

  it("resolves the Apple executable and support paths", () => {
    const runtime = resolveBundledGitRuntime("/Amend.app/Contents/Resources", {
      environment: {},
      platform: "darwin",
    })
    const environment = runtime.environment
    assert.ok(environment)

    assert.equal(
      runtime.executable,
      "/Amend.app/Contents/Resources/git/bin/git"
    )
    assert.equal(
      environment.GIT_CONFIG_SYSTEM,
      "/Amend.app/Contents/Resources/git/etc/gitconfig"
    )
    assert.equal(environment.PREFIX, undefined)
  })

  it("resolves the Windows executable and architecture paths", () => {
    const runtime = resolveBundledGitRuntime("C:\\Amend\\resources", {
      architecture: "arm64",
      environment: { PATH: "C:\\Windows" },
      platform: "win32",
    })
    const environment = runtime.environment
    assert.ok(environment)
    const gitDirectory = "C:\\Amend\\resources\\git"

    assert.equal(runtime.executable, `${gitDirectory}\\cmd\\git.exe`)
    assert.equal(
      environment.GIT_EXEC_PATH,
      `${gitDirectory}\\clangarm64\\libexec\\git-core`
    )
    assert.equal(
      environment.PATH,
      [
        `${gitDirectory}\\clangarm64\\bin`,
        `${gitDirectory}\\clangarm64\\usr\\bin`,
        "C:\\Windows",
      ].join(";")
    )
  })
})
