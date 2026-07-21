import {
  isActivateWorkspaceInput,
  isCancelIngestInput,
  isCreateWorkspaceInput,
  isIngestDocumentInput,
  isPiCancelLoginInput,
  isPiListModelsInput,
  isPiRespondToPromptInput,
  isPiSaveApiKeyInput,
  isPiSetDefaultModelInput,
  isReadWikiFileInput,
  isStartPiOAuthLoginInput,
  isThemeSource,
  isWikiSearchInput,
} from "@workspace/contract"
import { amendChannels } from "@workspace/contract/channels"
import type { AmendError, AmendResult } from "@workspace/contract"
import { dialog, ipcMain, nativeTheme } from "electron"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"

import type { PiCredentialService } from "./pi-credential-service"
import { isAllowedIpcSender } from "./security"
import { WorkspaceServiceError } from "./workspace-service"
import type { WorkspaceService } from "./workspace-service"

interface IpcAuthContext {
  allowedOrigin: string
  getWindow: () => BrowserWindow | undefined
}

interface WikiIpcOptions extends IpcAuthContext {
  service: WorkspaceService
}

interface PiIpcOptions extends IpcAuthContext {
  service: PiCredentialService
}

export function registerAppearanceIpc(options: IpcAuthContext): () => void {
  ipcMain.handle(
    amendChannels.setAppearanceTheme,
    authorized(options, async (_event, input: unknown) => {
      if (!isThemeSource(input)) return invalidInput()
      nativeTheme.themeSource = input
      return success(null)
    })
  )

  return () => ipcMain.removeHandler(amendChannels.setAppearanceTheme)
}

export function registerWikiIpc(options: WikiIpcOptions): () => void {
  const unsubscribeIngest = options.service.subscribeIngestChanged((event) => {
    const window = options.getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(amendChannels.ingestChanged, event)
    }
  })

  ipcMain.handle(
    amendChannels.chooseWorkspaceLocation,
    authorized(options, async (event) => {
      const window = options.getWindow()
      if (!window) return failure("unauthorized", "The window is unavailable.")
      const selection = await dialog.showOpenDialog(window, {
        title: "Choose where to create your wiki",
        buttonLabel: "Choose location",
        properties: ["openDirectory", "createDirectory"],
      })
      if (selection.canceled || !selection.filePaths[0]) return success(null)
      return await attempt(async () =>
        options.service.registerParentSelection(
          event.sender.id,
          selection.filePaths[0]
        )
      )
    })
  )

  ipcMain.handle(
    amendChannels.createWorkspace,
    authorized(options, async (event, input: unknown) => {
      if (!isCreateWorkspaceInput(input)) return invalidInput()
      return await attempt(async () =>
        options.service.createWorkspace(event.sender.id, input)
      )
    })
  )

  ipcMain.handle(
    amendChannels.openWorkspace,
    authorized(options, async () => {
      const window = options.getWindow()
      if (!window) return failure("unauthorized", "The window is unavailable.")
      const selection = await dialog.showOpenDialog(window, {
        title: "Open an existing wiki",
        buttonLabel: "Open workspace",
        properties: ["openDirectory"],
      })
      if (selection.canceled || !selection.filePaths[0]) return success(null)
      return await attempt(() =>
        options.service.openWorkspace(selection.filePaths[0])
      )
    })
  )

  ipcMain.handle(
    amendChannels.getCurrentWorkspace,
    authorized(
      options,
      async () =>
        await attempt(async () => options.service.getCurrentWorkspace())
    )
  )

  ipcMain.handle(
    amendChannels.listWorkspaces,
    authorized(
      options,
      async () => await attempt(async () => options.service.listWorkspaces())
    )
  )

  ipcMain.handle(
    amendChannels.activateWorkspace,
    authorized(options, async (_event, input: unknown) => {
      if (!isActivateWorkspaceInput(input)) return invalidInput()
      return await attempt(async () =>
        options.service.activateWorkspace(input.workspaceId)
      )
    })
  )

  ipcMain.handle(
    amendChannels.chooseSourceDocument,
    authorized(options, async (event) => {
      const window = options.getWindow()
      if (!window) return failure("unauthorized", "The window is unavailable.")
      const selection = await dialog.showOpenDialog(window, {
        title: "Choose the first source document",
        buttonLabel: "Choose document",
        properties: ["openFile"],
        filters: [
          {
            name: "Documents",
            extensions: ["pdf", "md", "markdown", "txt", "text"],
          },
        ],
      })
      if (selection.canceled || !selection.filePaths[0]) return success(null)
      return await attempt(async () =>
        options.service.registerSourceDocument(
          event.sender.id,
          selection.filePaths[0]
        )
      )
    })
  )

  ipcMain.handle(
    amendChannels.registerSourceDocument,
    authorized(options, async (event, input: unknown) => {
      if (!isDocumentPath(input)) return invalidInput()
      return await attempt(async () =>
        options.service.registerSourceDocument(event.sender.id, input)
      )
    })
  )

  ipcMain.handle(
    amendChannels.startIngest,
    authorized(options, async (event, input: unknown) => {
      if (!isIngestDocumentInput(input)) return invalidInput()
      return await attempt(async () =>
        options.service.startIngest(event.sender.id, input)
      )
    })
  )

  ipcMain.handle(
    amendChannels.getCurrentIngest,
    authorized(
      options,
      async () => await attempt(async () => options.service.getCurrentIngest())
    )
  )

  ipcMain.handle(
    amendChannels.cancelIngest,
    authorized(options, async (_event, input: unknown) => {
      if (!isCancelIngestInput(input)) return invalidInput()
      return await attempt(async () => {
        options.service.cancelIngest(input)
        return null
      })
    })
  )

  ipcMain.handle(
    amendChannels.refreshWikiIndex,
    authorized(
      options,
      async () => await attempt(async () => options.service.refreshIndex())
    )
  )

  ipcMain.handle(
    amendChannels.listWikiFiles,
    authorized(
      options,
      async () => await attempt(async () => options.service.listFiles())
    )
  )

  ipcMain.handle(
    amendChannels.readWikiFile,
    authorized(options, async (_event, input: unknown) => {
      if (!isReadWikiFileInput(input)) return invalidInput()
      return await attempt(async () => options.service.readFile(input))
    })
  )

  ipcMain.handle(
    amendChannels.searchWiki,
    authorized(options, async (_event, input: unknown) => {
      if (!isWikiSearchInput(input)) return invalidInput()
      return await attempt(async () => options.service.search(input))
    })
  )

  ipcMain.handle(
    amendChannels.listWikiTags,
    authorized(
      options,
      async () => await attempt(async () => options.service.listTags())
    )
  )

  return () => {
    unsubscribeIngest()
    for (const channel of [
      amendChannels.chooseWorkspaceLocation,
      amendChannels.createWorkspace,
      amendChannels.openWorkspace,
      amendChannels.getCurrentWorkspace,
      amendChannels.listWorkspaces,
      amendChannels.activateWorkspace,
      amendChannels.chooseSourceDocument,
      amendChannels.registerSourceDocument,
      amendChannels.startIngest,
      amendChannels.getCurrentIngest,
      amendChannels.cancelIngest,
      amendChannels.refreshWikiIndex,
      amendChannels.listWikiFiles,
      amendChannels.readWikiFile,
      amendChannels.searchWiki,
      amendChannels.listWikiTags,
    ]) {
      ipcMain.removeHandler(channel)
    }
  }
}

export function registerPiIpc(options: PiIpcOptions): () => void {
  const unsubscribeLogin = options.service.subscribeLoginEvents((event) => {
    const window = options.getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(amendChannels.providerOAuthEvent, event)
    }
  })

  ipcMain.handle(
    amendChannels.getProviderStatus,
    authorized(
      options,
      async () => await attempt(async () => options.service.status())
    )
  )

  ipcMain.handle(
    amendChannels.listProviders,
    authorized(
      options,
      async () =>
        await attempt(async () => options.service.listApiKeyProviders())
    )
  )

  ipcMain.handle(
    amendChannels.listProviderModels,
    authorized(options, async (_event, input: unknown) => {
      if (!isPiListModelsInput(input)) return invalidInput()
      return await attempt(async () =>
        options.service.listModels(input.provider)
      )
    })
  )

  ipcMain.handle(
    amendChannels.startProviderOAuth,
    authorized(options, async (_event, input: unknown) => {
      if (!isStartPiOAuthLoginInput(input)) return invalidInput()
      return await attempt(async () =>
        options.service.startOAuthLogin(input.provider)
      )
    })
  )

  ipcMain.handle(
    amendChannels.respondToProviderOAuthPrompt,
    authorized(options, async (_event, input: unknown) => {
      if (!isPiRespondToPromptInput(input)) return invalidInput()
      return await attempt(async () => {
        options.service.respondToPrompt(
          input.loginId,
          input.promptId,
          input.value
        )
        return null
      })
    })
  )

  ipcMain.handle(
    amendChannels.cancelProviderOAuth,
    authorized(options, async (_event, input: unknown) => {
      if (!isPiCancelLoginInput(input)) return invalidInput()
      return await attempt(async () => {
        options.service.cancelLogin(input.loginId)
        return null
      })
    })
  )

  ipcMain.handle(
    amendChannels.connectProviderWithApiKey,
    authorized(options, async (_event, input: unknown) => {
      if (!isPiSaveApiKeyInput(input)) return invalidInput()
      return await attempt(async () => {
        options.service.saveApiKeyCredential(input.provider, input.apiKey)
        return null
      })
    })
  )

  ipcMain.handle(
    amendChannels.setDefaultProviderModel,
    authorized(options, async (_event, input: unknown) => {
      if (!isPiSetDefaultModelInput(input)) return invalidInput()
      return await attempt(async () => {
        await options.service.setDefaultModel(input.provider, input.model)
        return null
      })
    })
  )

  return () => {
    unsubscribeLogin()
    for (const channel of [
      amendChannels.getProviderStatus,
      amendChannels.listProviders,
      amendChannels.listProviderModels,
      amendChannels.startProviderOAuth,
      amendChannels.respondToProviderOAuthPrompt,
      amendChannels.cancelProviderOAuth,
      amendChannels.connectProviderWithApiKey,
      amendChannels.setDefaultProviderModel,
    ]) {
      ipcMain.removeHandler(channel)
    }
  }
}

function authorized<T>(
  options: IpcAuthContext,
  handler: (
    event: IpcMainInvokeEvent,
    input?: unknown
  ) => Promise<AmendResult<T>>
): (event: IpcMainInvokeEvent, input?: unknown) => Promise<AmendResult<T>> {
  return async (event, input) => {
    const window = options.getWindow()
    const senderFrame = event.senderFrame
    if (
      !window ||
      !senderFrame ||
      !isAllowedIpcSender({
        senderId: event.sender.id,
        expectedSenderId: window.webContents.id,
        senderUrl: senderFrame.url,
        isMainFrame: senderFrame === event.sender.mainFrame,
        allowedOrigin: options.allowedOrigin,
      })
    ) {
      return failure("unauthorized", "The request was not authorized.")
    }
    try {
      return await handler(event, input)
    } catch {
      return failure(
        "operation-failed",
        "The operation could not be completed."
      )
    }
  }
}

async function attempt<T>(
  operation: () => Promise<T>
): Promise<AmendResult<T>> {
  try {
    return success(await operation())
  } catch (error) {
    if (error instanceof WorkspaceServiceError) {
      return failure(error.code, error.message)
    }
    return failure("operation-failed", "The operation could not be completed.")
  }
}

function success<T>(value: T): AmendResult<T> {
  return { ok: true, value }
}

function failure(
  code: AmendError["code"],
  message: string
): AmendResult<never> {
  return { ok: false, error: { code, message } }
}

function invalidInput(): AmendResult<never> {
  return failure("invalid-input", "The request contains invalid input.")
}

function isDocumentPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.includes("\0")
  )
}
