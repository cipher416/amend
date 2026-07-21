import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "vitest"

import { resolveRendererPath } from "./renderer-path.ts"

describe("renderer protocol paths", () => {
  const rendererRoot = path.resolve("amend-renderer")

  it("maps the application root to the SPA shell", () => {
    assert.equal(
      resolveRendererPath(rendererRoot, "app://amend/"),
      path.join(rendererRoot, "_shell.html")
    )
  })

  it("maps static assets inside the renderer root", () => {
    assert.equal(
      resolveRendererPath(rendererRoot, "app://amend/assets/index.js"),
      path.join(rendererRoot, "assets/index.js")
    )
  })

  it("rejects foreign origins and traversal attempts", () => {
    assert.equal(
      resolveRendererPath(rendererRoot, "app://other/assets/index.js"),
      null
    )
    assert.equal(
      resolveRendererPath(rendererRoot, "app://amend/%2e%2e%2fsecret"),
      null
    )
    assert.equal(
      resolveRendererPath(rendererRoot, "app://amend/%5c..%5csecret"),
      null
    )
  })
})
