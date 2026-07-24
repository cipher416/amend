import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "vitest"

import { configureGitRuntime, git } from "./git.ts"

const restoreRuntimes: Array<() => void> = []

afterEach(() => {
  while (restoreRuntimes.length > 0) {
    restoreRuntimes.pop()?.()
  }
})

describe("Git runtime", () => {
  it("uses the configured process environment", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "amend-git-"))
    restoreRuntimes.push(
      configureGitRuntime({
        executable: "git",
        environment: {
          ...process.env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "amend.runtime",
          GIT_CONFIG_VALUE_0: "bundled",
        },
      })
    )

    try {
      assert.equal(
        await git(workspacePath, "config", "--get", "amend.runtime"),
        "bundled"
      )
    } finally {
      await rm(workspacePath, { force: true, recursive: true })
    }
  })

  it("restores the previous runtime", async () => {
    const restore = configureGitRuntime({
      executable: "definitely-not-an-amend-git-runtime",
    })
    restore()

    assert.match(await git(process.cwd(), "--version"), /^git version /)
  })
})
