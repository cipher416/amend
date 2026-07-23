import { beforeEach, describe, expect, it, vi } from "vitest"

import { moveWikiToTrash } from "./trash"

const { trashItem } = vi.hoisted(() => ({
  trashItem: vi.fn<(path: string) => Promise<void>>(),
}))

vi.mock("electron", () => ({
  shell: { trashItem },
}))

describe("Electron Trash adapter", () => {
  beforeEach(() => {
    trashItem.mockReset()
    trashItem.mockResolvedValue(undefined)
  })

  it("moves the requested wiki through Electron's recoverable Trash API", async () => {
    await moveWikiToTrash("/wiki-home/Research")

    expect(trashItem).toHaveBeenCalledWith("/wiki-home/Research")
  })
})
