import path from "node:path"

import { app, BrowserWindow, session } from "electron"

import { registerRendererProtocol } from "./renderer-protocol"
import { rendererOrigin } from "./renderer-path"
import { isAllowedNavigation, secureWebPreferences } from "./security"

const developmentRendererUrl = "http://127.0.0.1:3000"

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
      preload: path.join(__dirname, "preload.js"),
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
      runtime: window.amend?.runtime
    })`)
    const passed =
      result.origin === rendererOrigin &&
      result.nodeType === "undefined" &&
      result.runtime === "electron"

    console.log("AMEND_SMOKE_RESULT", JSON.stringify(result))
    app.exit(passed ? 0 : 1)
  })

  void window.loadURL(rendererUrl)

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

  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
