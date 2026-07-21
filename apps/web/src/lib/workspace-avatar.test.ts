import { describe, expect, it } from "vitest"

import { workspaceAvatarDataUrl } from "./workspace-avatar"

describe("workspace avatar", () => {
  it("creates a stable avatar from the workspace ID", () => {
    const first = workspaceAvatarDataUrl("workspace-123")
    const second = workspaceAvatarDataUrl("workspace-123")

    expect(decodeURIComponent(first)).toContain("linearGradient")
    expect(second).toEqual(first)
  })

  it("gives different workspaces distinct gradients", () => {
    const avatar = workspaceAvatarDataUrl("another-workspace")

    expect(avatar).not.toEqual(workspaceAvatarDataUrl("workspace-123"))
  })
})
