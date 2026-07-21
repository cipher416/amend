import type {
  AmendApi,
  AmendResult,
  PiConnectionStatus,
  WikiFileContent,
  WikiFileTreeItem,
  WikiIngestJob,
  WikiSearchInput,
  WikiSearchResult,
  WikiHome,
  WikiListItem,
  WikiSummary,
} from "@workspace/contract"

export const providerStatusKey = ["providers", "status"] as const
export const wikiCurrentKey = ["wiki", "current"] as const
export const wikiHomeKey = ["wiki", "home"] as const
export const wikisKey = ["wikis"] as const
export const wikiIngestKey = (wikiId: string) =>
  ["wiki", wikiId, "ingest", "current"] as const
export const wikiFilesKey = (wikiId: string) =>
  ["wiki", wikiId, "files"] as const
export const wikiFileKey = (wikiId: string, path: string) =>
  ["wiki", wikiId, "file", path] as const

export async function readProviderStatus(
  api: AmendApi
): Promise<PiConnectionStatus> {
  return unwrapResult(await api.providers.status())
}

export async function readCurrentWiki(
  api: AmendApi
): Promise<WikiSummary | null> {
  return unwrapResult(await api.wikis.current())
}

export async function readWikiHome(api: AmendApi): Promise<WikiHome | null> {
  return unwrapResult(await api.wikis.home())
}

export async function chooseWikiHome(api: AmendApi): Promise<WikiHome | null> {
  return unwrapResult(await api.wikis.chooseHome())
}

export async function listWikis(
  api: AmendApi
): Promise<readonly WikiListItem[]> {
  return unwrapResult(await api.wikis.list())
}

export async function activateWikiById(
  api: AmendApi,
  wikiId: string
): Promise<WikiSummary> {
  return unwrapResult(await api.wikis.activate({ wikiId }))
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
