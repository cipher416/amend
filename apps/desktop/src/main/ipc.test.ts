import { afterEach, describe, expect, it, vi } from "vitest"

import { amendChannels } from "@workspace/contract/channels"

import { registerWikiIpc } from "./ipc.ts"
import type { WikiService } from "./wiki-service.ts"

const electron = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: unknown, input?: unknown) => unknown
  >()
  return {
    handlers,
    ipcMain: {
      handle: vi.fn(
        (
          channel: string,
          handler: (event: unknown, input?: unknown) => unknown
        ) => handlers.set(channel, handler)
      ),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    },
  }
})

vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: electron.ipcMain,
  nativeTheme: { themeSource: "system" },
}))

afterEach(() => {
  electron.handlers.clear()
  vi.clearAllMocks()
})

describe("wiki IPC", () => {
  it("validates and delegates wiki rename requests and removes the handler", async () => {
    const renamed = {
      id: "wiki_12345678",
      name: "Operations Wiki",
      domain: "Reliability",
      displayPath: "/wikis/Operations Wiki",
      commitHash: "abc123",
      setupStatus: "ready" as const,
    }
    const service = {
      subscribeIngestChanged: vi.fn(() => () => undefined),
      subscribeUpdateChanged: vi.fn(() => () => undefined),
      renameWiki: vi.fn(async () => renamed),
    } as unknown as WikiService
    const mainFrame = { url: "app://amend/wiki" }
    const window = {
      isDestroyed: () => false,
      webContents: { id: 7, mainFrame, send: vi.fn() },
    }
    const dispose = registerWikiIpc({
      allowedOrigin: "app://amend",
      getWindow: () => window as never,
      service,
    })
    const handler = electron.handlers.get(amendChannels.renameWiki)
    const event = {
      sender: { id: 7, mainFrame },
      senderFrame: mainFrame,
    }

    await expect(
      handler?.(event, {
        wikiId: "wiki_12345678",
        name: "Operations Wiki",
      })
    ).resolves.toEqual({ ok: true, value: renamed })
    expect(service.renameWiki).toHaveBeenCalledWith({
      wikiId: "wiki_12345678",
      name: "Operations Wiki",
    })

    await expect(
      handler?.(event, {
        wikiId: "wiki_12345678",
        name: "../escape",
      })
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid-input",
        message: "The request contains invalid input.",
      },
    })
    expect(service.renameWiki).toHaveBeenCalledTimes(1)

    dispose()
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledWith(
      amendChannels.renameWiki
    )
    expect(electron.handlers.has(amendChannels.renameWiki)).toBe(false)
  })
})
