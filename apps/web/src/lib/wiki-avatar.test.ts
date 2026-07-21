import { describe, expect, it } from "vitest"

import { wikiAvatarDataUrl } from "./wiki-avatar"

describe("wiki avatar", () => {
  it("creates a stable avatar from the wiki ID", () => {
    const first = wikiAvatarDataUrl("wiki-123")
    const second = wikiAvatarDataUrl("wiki-123")

    expect(decodeURIComponent(first)).toContain("linearGradient")
    expect(second).toEqual(first)
  })

  it("gives different wikis distinct gradients", () => {
    const avatar = wikiAvatarDataUrl("another-wiki")

    expect(avatar).not.toEqual(wikiAvatarDataUrl("wiki-123"))
  })
})
