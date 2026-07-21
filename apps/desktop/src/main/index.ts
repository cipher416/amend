import path from "node:path"
import { fileURLToPath } from "node:url"

import { app, BrowserWindow, nativeTheme, session, shell } from "electron"

import { registerAppearanceIpc, registerPiIpc, registerWikiIpc } from "./ipc"
import { PiCredentialService } from "./pi-credential-service"
import { registerRendererProtocol } from "./renderer-protocol"
import { rendererOrigin } from "./renderer-path"
import { resolveWikiSkillPath } from "./resource-paths"
import { isAllowedNavigation, secureWebPreferences } from "./security"
import { WorkspaceService } from "./workspace-service"

const developmentRendererUrl = "http://127.0.0.1:3001"
const mainDirectory = path.dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | undefined
let workspaceService: WorkspaceService | undefined
let piCredentialService: PiCredentialService | undefined
let disposeIpc: (() => void) | undefined
let disposePiIpc: (() => void) | undefined
let disposeAppearanceIpc: (() => void) | undefined
let shutdownStarted = false
let shutdownComplete = false

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      ...secureWebPreferences,
      preload: path.resolve(mainDirectory, "../preload/preload.js"),
    },
  })
  const rendererUrl = app.isPackaged
    ? `${rendererOrigin}/`
    : developmentRendererUrl
  const allowedOrigin = app.isPackaged
    ? rendererOrigin
    : new URL(rendererUrl).origin

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      void shell.openExternal(url).catch(() => undefined)
    }
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, navigationUrl) => {
    if (!isAllowedNavigation(navigationUrl, allowedOrigin)) {
      event.preventDefault()
    }
  })
  window.once("ready-to-show", () => {
    if (process.env.AMEND_SMOKE_TEST !== "1") {
      window.show()
    }
  })
  window.webContents.once("did-finish-load", async () => {
    if (process.env.AMEND_SMOKE_TEST !== "1") {
      return
    }

    const result = await window.webContents.executeJavaScript(`({
       origin: window.location.origin,
       nodeType: typeof window.process,
       runtime: window.amend?.runtime,
       hasWorkspaceApi: typeof window.amend?.workspaces?.create === "function",
       hasWikiApi: typeof window.amend?.wiki?.search === "function",
       hasProviderApi: typeof window.amend?.providers?.status === "function"
     })`)
    const passed =
      result.origin === rendererOrigin &&
      result.nodeType === "undefined" &&
      result.runtime === "electron" &&
      result.hasWorkspaceApi === true &&
      result.hasWikiApi === true &&
      result.hasProviderApi === true

    console.log("AMEND_SMOKE_RESULT", JSON.stringify(result))
    app.exit(passed ? 0 : 1)
  })

  void window.loadURL(rendererUrl)
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = undefined
  })
  mainWindow = window

  return window
}

function isExternalUrl(url: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

app.whenReady().then(async () => {
  if (app.isPackaged) {
    await registerRendererProtocol(path.join(process.resourcesPath, "client"))
  }

  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  )

  const allowedOrigin = app.isPackaged
    ? rendererOrigin
    : new URL(developmentRendererUrl).origin
  nativeTheme.themeSource = "system"
  workspaceService = new WorkspaceService({
    userDataPath: app.getPath("userData"),
    skillPath: resolveWikiSkillPath({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    }),
  })
  await workspaceService.restoreLastActiveWorkspace().catch((error: unknown) => {
    console.error("[amend] workspace restoration failed:", error)
  })
  disposeIpc = registerWikiIpc({
    service: workspaceService,
    allowedOrigin,
    getWindow: () => mainWindow,
  })
  piCredentialService = new PiCredentialService()
  disposePiIpc = registerPiIpc({
    service: piCredentialService,
    allowedOrigin,
    getWindow: () => mainWindow,
  })
  disposeAppearanceIpc = registerAppearanceIpc({
    allowedOrigin,
    getWindow: () => mainWindow,
  })
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on("before-quit", (event) => {
  if (!workspaceService || shutdownComplete) return
  event.preventDefault()
  if (shutdownStarted) return
  shutdownStarted = true
  void workspaceService.dispose().finally(() => {
    piCredentialService?.dispose()
    disposeAppearanceIpc?.()
    disposePiIpc?.()
    disposeIpc?.()
    shutdownComplete = true
    app.quit()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
