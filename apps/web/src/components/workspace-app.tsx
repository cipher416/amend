import { useQuery } from "@tanstack/react-query"
import { Outlet, useParams, useRouter } from "@tanstack/react-router"
import type {
  AmendApi,
  WikiFileContent,
  WikiFileTreeItem,
  WorkspaceSummary,
} from "@workspace/contract"
import type { WorkspaceBusy } from "./workspace-session"
import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@workspace/ui/components/sidebar"
import { Spinner } from "@workspace/ui/components/spinner"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { createContext, useContext, useRef } from "react"
import type { ReactNode } from "react"

import { errorMessage, useAmendApi } from "@/lib/amend-client"
import { readFile, workspaceFileKey } from "@/lib/workspace-queries"

import { parseMarkdownDocument, WikiFileViewer } from "./wiki-file-viewer"
import { WorkflowError } from "./wiki-workflow-ui"
import { WorkspaceSession, useWorkspaceSession } from "./workspace-session"
import { WorkspaceFileSearch } from "./workspace-file-search"
import { WorkspaceSidebar } from "./workspace-sidebar"
import { ThemeProvider } from "./theme"

interface WorkspaceViewContextValue {
  desktop: AmendApi
  workspace: WorkspaceSummary
  files: readonly WikiFileTreeItem[]
  busy: WorkspaceBusy
  error?: string
}

const WorkspaceViewContext = createContext<WorkspaceViewContextValue | null>(
  null
)

export function WorkspaceApp({ workspaceId }: { workspaceId: string }) {
  const desktop = useAmendApi()
  if (desktop === undefined) return <WorkspaceOpening />
  if (desktop === null) return <WorkspaceDesktopRequired />

  return (
    <WorkspaceSession desktop={desktop} workspaceId={workspaceId}>
      <WorkspaceAppContent />
    </WorkspaceSession>
  )
}

function WorkspaceAppContent() {
  const { desktop, opening, workspace, workspaces, files, busy, error } =
    useWorkspaceSession()
  const { _splat: selectedPath } = useParams({ strict: false })

  if (opening) return <WorkspaceOpening />
  if (!workspace) {
    if (error) return <WorkspaceLoadError message={error} />
    return <WorkspaceNotReady />
  }

  const running = workspaces.some(
    (item) => item.id === workspace.id && item.running
  )

  return (
    <WorkspaceViewContext.Provider
      value={{ desktop, workspace, files, busy, error }}
    >
      <WorkspaceShell
        sidebar={
          <WorkspaceSidebar
            desktop={desktop}
            workspace={workspace}
            workspaces={workspaces}
            files={files}
            selectedPath={selectedPath}
            switching={busy === "switch"}
            loadingFiles={busy === "files"}
            running={running}
          />
        }
      >
        <Outlet />
      </WorkspaceShell>
    </WorkspaceViewContext.Provider>
  )
}

export function WorkspaceEmptyContent() {
  const { workspace, files, busy, error } = useWorkspaceView()
  return (
    <WorkspaceMain
      workspace={workspace}
      files={files}
      busy={busy}
      error={error}
    />
  )
}

export function WorkspaceFileContent({
  workspaceId,
  filePath,
}: {
  workspaceId: string
  filePath: string
}) {
  const { desktop, workspace, files, busy, error } = useWorkspaceView()
  const queryClient = useRouter().options.context.queryClient
  const routeMatchesWorkspace = workspace.id === workspaceId
  const selectedFile = useQuery(
    {
      queryKey: routeMatchesWorkspace
        ? workspaceFileKey(workspaceId, filePath)
        : ["workspace", "file", "disabled"],
      queryFn: () => readFile(desktop, filePath),
      enabled: routeMatchesWorkspace,
    },
    queryClient
  )
  const fileBusy = selectedFile.isFetching ? "file" : busy
  const fileError = error ?? queryErrorMessage(selectedFile.error)

  return (
    <WorkspaceMain
      workspace={workspace}
      files={files}
      selectedFile={selectedFile.data}
      busy={fileBusy}
      error={fileError}
    />
  )
}

function useWorkspaceView(): WorkspaceViewContextValue {
  const value = useContext(WorkspaceViewContext)
  if (!value)
    throw new Error("Workspace route content must render inside WorkspaceApp")
  return value
}

function WorkspaceNotReady() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
      <section className="max-w-sm">
        <h1 className="font-heading text-3xl font-medium tracking-tight">
          Create a wiki first.
        </h1>
        <p className="mt-2 text-sm/relaxed text-muted-foreground">
          The workspace browser opens after your first source is committed.
        </p>
      </section>
    </main>
  )
}

function WorkspaceLoadError({ message }: { message: string }) {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
      <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
    </main>
  )
}

function WorkspaceOpening() {
  return (
    <main className="grid min-h-svh place-items-center bg-background text-foreground">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner />
        <span>Opening workspace</span>
      </div>
    </main>
  )
}

function WorkspaceDesktopRequired() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
      <section className="w-full max-w-sm">
        <h1 className="font-heading text-3xl font-medium tracking-tight">
          Your wiki lives on your machine.
        </h1>
        <p className="mt-2 text-sm/relaxed text-muted-foreground">
          Open this interface in the Amend desktop application to browse local
          workspace files.
        </p>
      </section>
    </main>
  )
}

function queryErrorMessage(error: Error | null): string | undefined {
  return error ? errorMessage(error) : undefined
}

function WorkspaceShell({
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

function WorkspaceMain({
  workspace,
  files,
  selectedFile,
  busy,
  error,
}: {
  workspace: WorkspaceSummary
  files: readonly WikiFileTreeItem[]
  selectedFile?: WikiFileContent
  busy: WorkspaceBusy
  error?: string
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const document =
    selectedFile?.mediaType === "markdown"
      ? parseMarkdownDocument(selectedFile.content ?? "")
      : undefined
  const headerTitle =
    document?.metadata.title ?? selectedFile?.name ?? workspace.name

  return (
    <>
      <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-2 bg-background/80 px-4 backdrop-blur-md">
        <SidebarTrigger className="mx-2" />
        <p className="min-w-0 flex-1 truncate font-heading text-sm font-medium">
          {headerTitle}
        </p>
        <WorkspaceFileSearch contentRef={contentRef} file={selectedFile} />
      </header>
      <main className="h-[calc(100svh-4rem)] w-full scroll-fade overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-8 py-8">
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
                workspaceId={workspace.id}
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
    </>
  )
}
