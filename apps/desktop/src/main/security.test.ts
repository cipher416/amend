import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { isAllowedNavigation, secureWebPreferences } from "./security.ts"

describe("desktop security", () => {
  it("keeps Node outside the renderer", () => {
    assert.equal(secureWebPreferences.nodeIntegration, false)
    assert.equal(secureWebPreferences.contextIsolation, true)
    assert.equal(secureWebPreferences.sandbox, true)
    assert.equal(secureWebPreferences.webSecurity, true)
    assert.equal(secureWebPreferences.webviewTag, false)
  })

  it("allows navigation only within the configured origin", () => {
    assert.equal(
      isAllowedNavigation("app://amend/pages/acme", "app://amend"),
      true
    )
    assert.equal(
      isAllowedNavigation("https://example.com", "app://amend"),
      false
    )
    assert.equal(isAllowedNavigation("not a url", "app://amend"), false)
  })
})
