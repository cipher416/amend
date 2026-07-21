import type { AmendApi } from "@workspace/contract"
import { describe, expect, it, vi } from "vitest"

import { readCurrentWorkspace, readWorkspaceHome } from "./workspace-queries"

describe("readCurrentWorkspace", () => {
  it("preserves IPC failures instead of treating them as no active workspace", async () => {
    const api = {
      workspaces: {
        current: vi.fn(async () => ({
          ok: false as const,
          error: {
            code: "operation-failed" as const,
            message: "IPC unavailable",
          },
        })),
      },
    } as unknown as AmendApi

    await expect(readCurrentWorkspace(api)).rejects.toThrow("IPC unavailable")
  })
})

describe("readWorkspaceHome", () => {
  it("returns the one configured Amend home", async () => {
    const api = {
      workspaces: {
        home: vi.fn(async () => ({
          ok: true as const,
          value: { displayPath: "/research" },
        })),
      },
    } as unknown as AmendApi

    await expect(readWorkspaceHome(api)).resolves.toEqual({
      displayPath: "/research",
    })
  })
})
