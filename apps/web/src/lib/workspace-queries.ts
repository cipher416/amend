import type {
  AmendApi,
  AmendResult,
  PiConnectionStatus,
  WikiFileContent,
  WikiFileTreeItem,
  WikiIngestJob,
  WikiSearchInput,
  WikiSearchResult,
  WorkspaceHome,
  WorkspaceListItem,
  WorkspaceSummary,
} from "@workspace/contract"

export const providerStatusKey = ["providers", "status"] as const
export const workspaceCurrentKey = ["workspace", "current"] as const
export const workspaceHomeKey = ["workspace", "home"] as const
export const workspacesKey = ["workspaces"] as const
export const workspaceIngestKey = (workspaceId: string) =>
  ["workspace", workspaceId, "ingest", "current"] as const
export const workspaceFilesKey = (workspaceId: string) =>
  ["workspace", workspaceId, "files"] as const
export const workspaceFileKey = (workspaceId: string, path: string) =>
  ["workspace", workspaceId, "file", path] as const

export async function readProviderStatus(
  api: AmendApi
): Promise<PiConnectionStatus> {
  return unwrapResult(await api.providers.status())
}

export async function readCurrentWorkspace(
  api: AmendApi
): Promise<WorkspaceSummary | null> {
  return unwrapResult(await api.workspaces.current())
}

export async function readWorkspaceHome(
  api: AmendApi
): Promise<WorkspaceHome | null> {
  return unwrapResult(await api.workspaces.home())
}

export async function chooseWorkspaceHome(
  api: AmendApi
): Promise<WorkspaceHome | null> {
  return unwrapResult(await api.workspaces.chooseHome())
}

export async function listWorkspaces(
  api: AmendApi
): Promise<readonly WorkspaceListItem[]> {
  return unwrapResult(await api.workspaces.list())
}

export async function activateWorkspaceById(
  api: AmendApi,
  workspaceId: string
): Promise<WorkspaceSummary> {
  return unwrapResult(await api.workspaces.activate({ workspaceId }))
}

export async function readCurrentIngest(
  api: AmendApi
): Promise<WikiIngestJob | null> {
  return unwrapResult(await api.wiki.currentIngest())
}

export async function listFiles(
  api: AmendApi
): Promise<readonly WikiFileTreeItem[]> {
  return unwrapResult(await api.wiki.listFiles())
}

export async function readFile(
  api: AmendApi,
  path: string
): Promise<WikiFileContent> {
  return unwrapResult(await api.wiki.readFile({ path }))
}

export async function searchWiki(
  api: AmendApi,
  input: WikiSearchInput
): Promise<readonly WikiSearchResult[]> {
  return unwrapResult(await api.wiki.search(input))
}

export function unwrapResult<T>(response: AmendResult<T>): T {
  if (!response.ok) throw new Error(response.error.message)
  return response.value
}
