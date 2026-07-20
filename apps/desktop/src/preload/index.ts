import { amendChannels } from "@workspace/contract/channels"
import {
  isAmendResult,
  isNull,
  isSourceDocumentSelection,
  isSourceDocumentSelectionOrNull,
  isStartIngestResult,
  isWikiIndexRefreshSummary,
  isWikiIngestJob,
  isWikiIngestJobOrNull,
  isWikiSearchResults,
  isWikiTagFacets,
  isWorkspaceParentSelectionOrNull,
  isWorkspaceSummary,
  isWorkspaceSummaryOrNull,
} from "@workspace/contract/guards"
import type { Guard } from "@workspace/contract/guards"
import type {
  AmendApi,
  AmendResult,
  CancelIngestInput,
  CreateWorkspaceInput,
  IngestDocumentInput,
  WikiIngestJob,
  WikiSearchInput,
  WorkspaceParentSelection,
} from "@workspace/contract"
import { contextBridge, ipcRenderer, webUtils } from "electron"

const workspace = Object.freeze({
  chooseParent: () =>
    invoke<WorkspaceParentSelection | null>(
      amendChannels.chooseWorkspaceParent,
      isWorkspaceParentSelectionOrNull
    ),
  create: (input: CreateWorkspaceInput) =>
    invoke(amendChannels.createWorkspace, isWorkspaceSummary, input),
  current: () =>
    invoke(amendChannels.getCurrentWorkspace, isWorkspaceSummaryOrNull),
})

const wiki = Object.freeze({
  chooseDocument: () =>
    invoke(amendChannels.chooseSourceDocument, isSourceDocumentSelectionOrNull),
  registerDocument: (file: File) => {
    let path: string
    try {
      path = webUtils.getPathForFile(file)
    } catch {
      return Promise.resolve({
        ok: false as const,
        error: {
          code: "invalid-input" as const,
          message: "Choose a document from your computer.",
        },
      })
    }
    if (!path) {
      return Promise.resolve({
        ok: false as const,
        error: {
          code: "invalid-input" as const,
          message: "Choose a document from your computer.",
        },
      })
    }
    return invoke(
      amendChannels.registerSourceDocument,
      isSourceDocumentSelection,
      path
    )
  },
  startIngest: (input: IngestDocumentInput) =>
    invoke(amendChannels.startIngest, isStartIngestResult, input),
  currentIngest: () =>
    invoke(amendChannels.getCurrentIngest, isWikiIngestJobOrNull),
  cancelIngest: (input: CancelIngestInput) =>
    invoke(amendChannels.cancelIngest, isNull, input),
  refreshIndex: () =>
    invoke(amendChannels.refreshWikiIndex, isWikiIndexRefreshSummary),
  search: (input: WikiSearchInput) =>
    invoke(amendChannels.searchWiki, isWikiSearchResults, input),
  listTags: () => invoke(amendChannels.listWikiTags, isWikiTagFacets),
  onIngestChanged(listener: (job: WikiIngestJob) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, job: unknown) => {
      if (isWikiIngestJob(job)) listener(job)
    }
    ipcRenderer.on(amendChannels.ingestChanged, wrapped)
    return () => {
      ipcRenderer.removeListener(amendChannels.ingestChanged, wrapped)
    }
  },
})

const amendApi = Object.freeze({
  runtime: "electron" as const,
  platform: process.platform,
  workspace,
  wiki,
}) satisfies AmendApi

contextBridge.exposeInMainWorld("amend", amendApi)

async function invoke<T>(
  channel: string,
  guard: Guard<T>,
  input?: unknown
): Promise<AmendResult<T>> {
  const response: unknown =
    input === undefined
      ? await ipcRenderer.invoke(channel)
      : await ipcRenderer.invoke(channel, input)
  if (!isAmendResult(response, guard)) {
    throw new Error(`Invalid response from Electron main: ${channel}`)
  }
  return response
}
