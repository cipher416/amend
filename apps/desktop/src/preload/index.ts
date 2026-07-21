import { amendChannels } from "@workspace/contract/channels"
import {
  isAmendResult,
  isNull,
  isPiConnectionStatus,
  isPiLoginEvent,
  isPiModelSummaries,
  isPiProviderSummaries,
  isSourceDocumentSelection,
  isSourceDocumentSelectionOrNull,
  isStartIngestResult,
  isStartPiOAuthLoginResult,
  isWikiFileContent,
  isWikiFileTreeItems,
  isWikiIndexRefreshSummary,
  isWikiIngestChangedEvent,
  isWikiIngestJobOrNull,
  isWikiSearchResults,
  isWikiTagFacets,
  isWorkspaceListItems,
  isWorkspaceParentSelectionOrNull,
  isWorkspaceSummary,
  isWorkspaceSummaryOrNull,
} from "@workspace/contract/guards"
import type { Guard } from "@workspace/contract/guards"
import type {
  ActivateWorkspaceInput,
  AmendApi,
  AmendResult,
  CancelIngestInput,
  CreateWorkspaceInput,
  IngestDocumentInput,
  PiCancelLoginInput,
  PiListModelsInput,
  PiLoginEvent,
  PiRespondToPromptInput,
  PiSaveApiKeyInput,
  PiSetDefaultModelInput,
  ReadWikiFileInput,
  StartPiOAuthLoginInput,
  WikiIngestChangedEvent,
  WikiSearchInput,
  WorkspaceParentSelection,
} from "@workspace/contract"
import { contextBridge, ipcRenderer, webUtils } from "electron"

const workspaces = Object.freeze({
  chooseLocation: () =>
    invoke<WorkspaceParentSelection | null>(
      amendChannels.chooseWorkspaceLocation,
      isWorkspaceParentSelectionOrNull
    ),
  create: (input: CreateWorkspaceInput) =>
    invoke(amendChannels.createWorkspace, isWorkspaceSummary, input),
  open: () => invoke(amendChannels.openWorkspace, isWorkspaceSummaryOrNull),
  current: () =>
    invoke(amendChannels.getCurrentWorkspace, isWorkspaceSummaryOrNull),
  list: () => invoke(amendChannels.listWorkspaces, isWorkspaceListItems),
  activate: (input: ActivateWorkspaceInput) =>
    invoke(amendChannels.activateWorkspace, isWorkspaceSummary, input),
})

const providers = Object.freeze({
  status: () => invoke(amendChannels.getProviderStatus, isPiConnectionStatus),
  list: () => invoke(amendChannels.listProviders, isPiProviderSummaries),
  listModels: (input: PiListModelsInput) =>
    invoke(amendChannels.listProviderModels, isPiModelSummaries, input),
  startOAuth: (input: StartPiOAuthLoginInput) =>
    invoke(amendChannels.startProviderOAuth, isStartPiOAuthLoginResult, input),
  respondToOAuthPrompt: (input: PiRespondToPromptInput) =>
    invoke(amendChannels.respondToProviderOAuthPrompt, isNull, input),
  cancelOAuth: (input: PiCancelLoginInput) =>
    invoke(amendChannels.cancelProviderOAuth, isNull, input),
  connectWithApiKey: (input: PiSaveApiKeyInput) =>
    invoke(amendChannels.connectProviderWithApiKey, isNull, input),
  setDefaultModel: (input: PiSetDefaultModelInput) =>
    invoke(amendChannels.setDefaultProviderModel, isNull, input),
  onOAuthEvent(listener: (event: PiLoginEvent) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (isPiLoginEvent(payload)) listener(payload)
    }
    ipcRenderer.on(amendChannels.providerOAuthEvent, wrapped)
    return () => {
      ipcRenderer.removeListener(amendChannels.providerOAuthEvent, wrapped)
    }
  },
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
  listFiles: () => invoke(amendChannels.listWikiFiles, isWikiFileTreeItems),
  readFile: (input: ReadWikiFileInput) =>
    invoke(amendChannels.readWikiFile, isWikiFileContent, input),
  search: (input: WikiSearchInput) =>
    invoke(amendChannels.searchWiki, isWikiSearchResults, input),
  listTags: () => invoke(amendChannels.listWikiTags, isWikiTagFacets),
  onIngestChanged(listener: (event: WikiIngestChangedEvent) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (isWikiIngestChangedEvent(payload)) listener(payload)
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
  workspaces,
  providers,
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
