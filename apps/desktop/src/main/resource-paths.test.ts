import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "vitest"

import { resolveWikiSkillPath } from "./resource-paths.ts"

describe("wiki skill path", () => {
  it("resolves the repository skill during development", () => {
    assert.equal(
      resolveWikiSkillPath({
        isPackaged: false,
        appPath: "/repo/apps/desktop",
        resourcesPath: "/unused",
      }),
      path.resolve("/repo/packages/wiki-engine/skills/llm-wiki/SKILL.md")
    )
  })

  it("resolves the copied skill in packaged resources", () => {
    assert.equal(
      resolveWikiSkillPath({
        isPackaged: true,
        appPath: "/unused",
        resourcesPath: "/app/resources",
      }),
      path.resolve("/app/resources/llm-wiki/SKILL.md")
    )
  })
})
