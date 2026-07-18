import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { net, protocol } from "electron"

import {
  rendererScheme,
  rendererShellFileName,
  resolveRendererPath,
} from "./renderer-path"

protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
])

async function isFile(filePath: string) {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

function injectContentSecurityPolicy(html: string) {
  const nonce = crypto.randomUUID().replaceAll("-", "")
  const content = html.replace(
    /<(script|style)(?=\s|>)/g,
    `<$1 nonce="${nonce}"`
  )
  const policy = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ")

  return new Response(content, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": policy,
    },
  })
}

export async function registerRendererProtocol(rendererRoot: string) {
  await protocol.handle(rendererScheme, async (request) => {
    const requestedPath = resolveRendererPath(rendererRoot, request.url)

    if (requestedPath === null) {
      return new Response("Bad request", { status: 400 })
    }

    if (await isFile(requestedPath)) {
      if (path.basename(requestedPath) === rendererShellFileName) {
        return injectContentSecurityPolicy(
          await readFile(requestedPath, "utf8")
        )
      }

      return net.fetch(pathToFileURL(requestedPath).toString())
    }

    if (path.extname(requestedPath) !== "") {
      return new Response("Not found", { status: 404 })
    }

    const shellPath = path.join(rendererRoot, rendererShellFileName)
    return injectContentSecurityPolicy(await readFile(shellPath, "utf8"))
  })
}
