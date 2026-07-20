import path from "node:path"
import { fileURLToPath } from "node:url"

import { app, BrowserWindow, session } from "electron"

import { registerWikiIpc } from "./ipc"
import { registerRendererProtocol } from "./renderer-protocol"
import { rendererOrigin } from "./renderer-path"
import { resolveWikiSkillPath } from "./resource-paths"
import { isAllowedNavigation, secureWebPreferences } from "./security"
import { WorkspaceService } from "./workspace-service"

const developmentRendererUrl = "http://127.0.0.1:3001"
const mainDirectory = path.dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | undefined
let workspaceService: WorkspaceService | undefined
let disposeIpc: (() => void) | undefined
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

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
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
       hasWorkspaceApi: typeof window.amend?.workspace?.create === "function",
       hasWikiApi: typeof window.amend?.wiki?.search === "function"
     })`)
    const passed =
      result.origin === rendererOrigin &&
      result.nodeType === "undefined" &&
      result.runtime === "electron" &&
      result.hasWorkspaceApi === true &&
      result.hasWikiApi === true

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
  workspaceService = new WorkspaceService({
    userDataPath: app.getPath("userData"),
    skillPath: resolveWikiSkillPath({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    }),
  })
  disposeIpc = registerWikiIpc({
    service: workspaceService,
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
