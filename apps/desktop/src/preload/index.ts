import { contextBridge } from "electron"

const amendApi = Object.freeze({
  runtime: "electron" as const,
  platform: process.platform,
})

contextBridge.exposeInMainWorld("amend", amendApi)
