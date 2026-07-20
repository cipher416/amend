import type { WebPreferences } from "electron"

export const secureWebPreferences = {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
} as const satisfies WebPreferences

export function isAllowedNavigation(
  navigationUrl: string,
  allowedOrigin: string
) {
  try {
    const navigation = new URL(navigationUrl)
    const allowed = new URL(allowedOrigin)

    return (
      navigation.protocol === allowed.protocol &&
      navigation.host === allowed.host
    )
  } catch {
    return false
  }
}

export function isAllowedIpcSender(input: {
  senderId: number
  expectedSenderId: number
  senderUrl: string
  isMainFrame: boolean
  allowedOrigin: string
}): boolean {
  return (
    input.senderId === input.expectedSenderId &&
    input.isMainFrame &&
    isAllowedNavigation(input.senderUrl, input.allowedOrigin)
  )
}
