import type { AmendApi } from "@workspace/contract"
import { describe, expect, it, vi } from "vitest"

import { readCurrentWiki, readWikiHome } from "./wiki-queries"

describe("readCurrentWiki", () => {
  it("preserves IPC failures instead of treating them as no active wiki", async () => {
    const api = {
      wikis: {
        current: vi.fn(async () => ({
          ok: false as const,
          error: {
            code: "operation-failed" as const,
            message: "IPC unavailable",
          },
        })),
      },
    } as unknown as AmendApi

    await expect(readCurrentWiki(api)).rejects.toThrow("IPC unavailable")
  })
})

describe("readWikiHome", () => {
  it("returns the one configured Amend home", async () => {
    const api = {
      wikis: {
        home: vi.fn(async () => ({
          ok: true as const,
          value: { displayPath: "/research" },
        })),
      },
    } as unknown as AmendApi

    await expect(readWikiHome(api)).resolves.toEqual({
      displayPath: "/research",
    })
  })
})
