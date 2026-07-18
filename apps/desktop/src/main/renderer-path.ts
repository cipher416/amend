import path from "node:path"

export const rendererScheme = "app"
export const rendererHost = "amend"
export const rendererShellFileName = "_shell.html"
export const rendererOrigin = `${rendererScheme}://${rendererHost}`

export function resolveRendererPath(
  rendererRoot: string,
  requestUrl: string
): string | null {
  let url: URL

  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }

  if (url.protocol !== `${rendererScheme}:` || url.host !== rendererHost) {
    return null
  }

  let pathname: string

  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }

  if (pathname.includes("\\") || pathname.includes("\0")) {
    return null
  }

  if (pathname === "/") {
    return path.join(rendererRoot, rendererShellFileName)
  }

  const candidate = path.resolve(rendererRoot, `.${pathname}`)
  const relativePath = path.relative(rendererRoot, candidate)

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null
  }

  return candidate
}
