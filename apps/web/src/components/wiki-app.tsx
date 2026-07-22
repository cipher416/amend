import { useQuery } from "@tanstack/react-query"
import { Outlet, useParams, useRouter } from "@tanstack/react-router"
import type {
  AmendApi,
  WikiFileContent,
  WikiFileTreeItem,
  WikiSummary,
  WikiUpdateSession,
} from "@workspace/contract"
import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@workspace/ui/components/sidebar"
import { Spinner } from "@workspace/ui/components/spinner"
import { Button } from "@workspace/ui/components/button"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { createContext, useContext, useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"

import { errorMessage, useAmendApi } from "@/lib/amend-client"
import { readFile, wikiFileKey } from "@/lib/wiki-queries"

import { ThemeProvider } from "./theme"
import { WikiFileSearch } from "./wiki-file-search"
import { parseMarkdownDocument, WikiFileViewer } from "./wiki-file-viewer"
import { WikiIngestCompletionToast } from "./wiki-ingest-completion-toast"
import { WikiSession, useWikiSession } from "./wiki-session"
import type { WikiBusy } from "./wiki-session"
import { WikiSidebar } from "./wiki-sidebar"
import { WikiUpdatePanel } from "./wiki-update-panel"
import { WorkflowError } from "./wiki-workflow-ui"

interface WikiViewContextValue {
  desktop: AmendApi
  wiki: WikiSummary
  files: readonly WikiFileTreeItem[]
  busy: WikiBusy
  error?: string
  update: WikiUpdateSession | null
}

const WikiViewContext = createContext<WikiViewContextValue | null>(null)

export function WikiApp({ wikiId }: { wikiId: string }) {
  const desktop = useAmendApi()
  if (desktop === undefined) return <WikiOpening />
  if (desktop === null) return <WikiDesktopRequired />

  return (
    <WikiSession desktop={desktop} wikiId={wikiId}>
      <WikiAppContent />
    </WikiSession>
  )
}

function WikiAppContent() {
  const {
    desktop,
    opening,
    wiki,
    wikis,
    files,
    busy,
    error,
    ingestCompletionNotice,
    update,
    dismissIngestCompletionNotice,
  } = useWikiSession()
  const { _splat: selectedPath } = useParams({ strict: false })

  if (opening) return <WikiOpening />
  if (!wiki) {
    if (error) return <WikiLoadError message={error} />
    return <WikiNotReady />
  }

  const running = wikis.some((item) => item.id === wiki.id && item.running)

  return (
    <>
      <WikiViewContext.Provider
        value={{ desktop, wiki, files, busy, error, update }}
      >
        <WikiShell
          sidebar={
            <WikiSidebar
              desktop={desktop}
              wiki={wiki}
              wikis={wikis}
              files={files}
              selectedPath={selectedPath}
              switching={busy === "switch"}
              loadingFiles={busy === "files"}
              running={running}
            />
          }
        >
          <Outlet />
        </WikiShell>
      </WikiViewContext.Provider>
      <WikiIngestCompletionToast
        key={ingestCompletionNotice?.jobId}
        notice={ingestCompletionNotice}
        onDismiss={dismissIngestCompletionNotice}
      />
    </>
  )
}

export function WikiEmptyContent() {
  const { desktop, wiki, files, busy, error, update } = useWikiView()
  return (
    <WikiMain
      desktop={desktop}
      wiki={wiki}
      files={files}
      busy={busy}
      error={error}
      update={update}
    />
  )
}

export function WikiFileContent({
  wikiId,
  filePath,
}: {
  wikiId: string
  filePath: string
}) {
  const { desktop, wiki, files, busy, error, update } = useWikiView()
  const queryClient = useRouter().options.context.queryClient
  const routeMatchesWiki = wiki.id === wikiId
  const selectedFile = useQuery(
    {
      queryKey: routeMatchesWiki
        ? wikiFileKey(wikiId, filePath)
        : ["wiki", "file", "disabled"],
      queryFn: () => readFile(desktop, filePath),
      enabled: routeMatchesWiki,
    },
    queryClient
  )
  const fileBusy = selectedFile.isFetching ? "file" : busy
  const fileError = error ?? queryErrorMessage(selectedFile.error)

  return (
    <WikiMain
      wiki={wiki}
      desktop={desktop}
      files={files}
      selectedFile={selectedFile.data}
      busy={fileBusy}
      error={fileError}
      update={update}
    />
  )
}

function useWikiView(): WikiViewContextValue {
  const value = useContext(WikiViewContext)
  if (!value) throw new Error("Wiki route content must render inside WikiApp")
  return value
}

function WikiNotReady() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
      <section className="max-w-sm">
        <h1 className="font-heading text-3xl font-medium tracking-tight">
          Create a wiki first.
        </h1>
        <p className="mt-2 text-sm/relaxed text-muted-foreground">
          The wiki opens after your first source is committed.
        </p>
      </section>
    </main>
  )
}

function WikiLoadError({ message }: { message: string }) {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
      <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
    </main>
  )
}

function WikiOpening() {
  return (
    <main className="grid min-h-svh place-items-center bg-background text-foreground">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner />
        <span>Opening wiki</span>
      </div>
    </main>
  )
}

function WikiDesktopRequired() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
      <section className="w-full max-w-sm">
        <h1 className="font-heading text-3xl font-medium tracking-tight">
          Your wiki lives on your machine.
        </h1>
        <p className="mt-2 text-sm/relaxed text-muted-foreground">
          Open this interface in the Amend desktop application to browse local
          wiki files.
        </p>
      </section>
    </main>
  )
}

function queryErrorMessage(error: Error | null): string | undefined {
  return error ? errorMessage(error) : undefined
}

function WikiShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode
  children: ReactNode
}) {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <SidebarProvider>
          <Sidebar collapsible="offcanvas">
            {sidebar}
            <SidebarRail />
          </Sidebar>
          <SidebarInset>{children}</SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}

function WikiMain({
  desktop,
  wiki,
  files,
  selectedFile,
  busy,
  error,
  update,
}: {
  desktop: AmendApi
  wiki: WikiSummary
  files: readonly WikiFileTreeItem[]
  selectedFile?: WikiFileContent
  busy: WikiBusy
  error?: string
  update: WikiUpdateSession | null
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateCompletion, setUpdateCompletion] = useState<string>()
  const document =
    selectedFile?.mediaType === "markdown"
      ? parseMarkdownDocument(selectedFile.content ?? "")
      : undefined
  const headerTitle =
    document?.metadata.title ?? selectedFile?.name ?? wiki.name

  return (
    <>
      <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-2 bg-background/80 px-4 backdrop-blur-md">
        <SidebarTrigger className="mx-2" />
        <p className="min-w-0 flex-1 truncate font-heading text-sm font-medium">
          {headerTitle}
        </p>
        <Button
          type="button"
          size="sm"
          variant={updateOpen ? "secondary" : "outline"}
          onClick={() => setUpdateOpen((open) => !open)}
        >
          Update
          {update ? (
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-primary"
              title="Update session available"
            />
          ) : null}
        </Button>
        <WikiFileSearch contentRef={contentRef} file={selectedFile} />
      </header>
      <div className="flex h-[calc(100svh-4rem)] min-w-0">
        <main className="min-w-0 flex-1 scroll-fade overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-8 py-8">
            <WorkflowError message={error} />
            {busy === "file" ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                <span>Opening file</span>
              </div>
            ) : selectedFile ? (
              <div ref={contentRef}>
                <WikiFileViewer
                  file={selectedFile}
                  document={document}
                  wikiId={wiki.id}
                  files={files}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Select a file from the sidebar.
              </p>
            )}
          </div>
        </main>
        {updateOpen ? (
          <WikiUpdatePanel
            desktop={desktop}
            wikiId={wiki.id}
            contextPath={selectedFile?.path}
            session={update}
            onClose={() => setUpdateOpen(false)}
            onApplied={setUpdateCompletion}
          />
        ) : null}
      </div>
      <WikiUpdateCompletionToast
        message={updateCompletion}
        onDismiss={() => setUpdateCompletion(undefined)}
      />
    </>
  )
}

function WikiUpdateCompletionToast({
  message,
  onDismiss,
}: {
  message?: string
  onDismiss: () => void
}) {
  useEffect(() => {
    if (!message) return
    const timeout = window.setTimeout(onDismiss, 5_000)
    return () => window.clearTimeout(timeout)
  }, [message, onDismiss])

  if (!message) return null
  return (
    <div
      aria-live="polite"
      className="fixed right-4 bottom-4 z-50 max-w-sm rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
      role="status"
    >
      {message}
    </div>
  )
}
