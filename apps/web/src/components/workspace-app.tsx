import { createContext, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"
import {
  useMutation,
  useQuery,
} from "@tanstack/react-query"
import {
  Link,
  Outlet,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"
import type {
  AmendApi,
  WikiFileContent,
  WikiFileTreeItem,
  WorkspaceListItem,
  WorkspaceSummary,
} from "@workspace/contract"
import { Button } from "@workspace/ui/components/button"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@workspace/ui/components/sidebar"
import { Spinner } from "@workspace/ui/components/spinner"
import { TooltipProvider } from "@workspace/ui/components/tooltip"

import { errorMessage, useAmendApi } from "@/lib/amend-client"
import {
  activateWorkspaceById,
  listFiles,
  listWorkspaces,
  openExistingWorkspace,
  readCurrentWorkspace,
  readFile,
  workspaceCurrentKey,
  workspaceFileKey,
  workspaceFilesKey,
  workspacesKey,
} from "@/lib/workspace-queries"

import { WorkflowError } from "./wiki-workflow-ui"

type WorkspaceBusy = "open" | "switch" | "files" | "file" | null

interface WorkspaceSession {
  opening: boolean
  workspace?: WorkspaceSummary
  workspaces: readonly WorkspaceListItem[]
  files: readonly WikiFileTreeItem[]
  selectedPath?: string
  busy: WorkspaceBusy
  error?: string
  openWorkspace: () => Promise<string | null>
}

interface WorkspaceViewContextValue {
  desktop: AmendApi
  workspace: WorkspaceSummary
  busy: WorkspaceBusy
  error?: string
}

const WorkspaceViewContext = createContext<WorkspaceViewContextValue | null>(null)

export function WorkspaceApp({
  noWorkspaceElement,
}: {
  noWorkspaceElement?: ReactNode
}) {
  const desktop = useAmendApi()
  if (desktop === undefined) return <WorkspaceOpening />
  if (desktop === null) return <WorkspaceDesktopRequired />
  const { workspaceId, filePath } = useWorkspaceRouteSelection()

  return (
    <WorkspaceRuntime
      desktop={desktop}
      noWorkspaceElement={noWorkspaceElement}
      workspaceId={workspaceId}
      selectedPath={filePath}
    />
  )
}

function useWorkspaceRouteSelection(): {
  workspaceId?: string
  filePath?: string
} {
  return useRouterState({
    select: (state) => {
      const match = state.matches.at(-1)
      const params = match?.params
      const workspaceId =
        params && "workspaceId" in params && typeof params.workspaceId === "string"
          ? params.workspaceId
          : undefined
      const filePath =
        params && "_splat" in params && typeof params._splat === "string"
          ? params._splat
          : undefined
      return { workspaceId, filePath }
    },
  })
}

function WorkspaceRuntime({
  desktop,
  noWorkspaceElement,
  workspaceId,
  selectedPath,
}: {
  desktop: AmendApi
  noWorkspaceElement?: ReactNode
  workspaceId?: string
  selectedPath?: string
}) {
  const session = useWorkspaceSession({ desktop, workspaceId, selectedPath })

  return (
    <WorkspaceRuntimeContent
      desktop={desktop}
      session={session}
      noWorkspaceElement={noWorkspaceElement}
    />
  )
}

function useWorkspaceSession({
  desktop,
  workspaceId,
  selectedPath,
}: {
  desktop: AmendApi
  workspaceId?: string
  selectedPath?: string
}): WorkspaceSession {
  const queryClient = useRouter().options.context.queryClient
  const [operationError, setOperationError] = useState<string>()

  const currentWorkspace = useQuery(
    {
      queryKey: workspaceCurrentKey,
      queryFn: () => readCurrentWorkspace(desktop),
    },
    queryClient
  )
  const workspaces = useQuery(
    {
      queryKey: workspacesKey,
      queryFn: () => listWorkspaces(desktop),
    },
    queryClient
  )

  const activateWorkspace = useMutation(
    {
      mutationFn: (nextWorkspaceId: string) =>
        activateWorkspaceById(desktop, nextWorkspaceId),
      onMutate: () => setOperationError(undefined),
      onSuccess: (workspace) => {
        queryClient.setQueryData(workspaceCurrentKey, workspace)
        void queryClient.invalidateQueries({ queryKey: workspacesKey })
        void queryClient.invalidateQueries({
          queryKey: workspaceFilesKey(workspace.id),
        })
      },
      onError: (cause) => setOperationError(errorMessage(cause)),
    },
    queryClient
  )
  const openWorkspace = useMutation(
    {
      mutationFn: () => openExistingWorkspace(desktop),
      onMutate: () => setOperationError(undefined),
      onSuccess: (workspace) => {
        if (!workspace) {
          void queryClient.invalidateQueries({ queryKey: workspacesKey })
          return
        }
        queryClient.setQueryData(workspaceCurrentKey, workspace)
        void queryClient.invalidateQueries({ queryKey: workspacesKey })
        void queryClient.invalidateQueries({
          queryKey: workspaceFilesKey(workspace.id),
        })
      },
      onError: (cause) => setOperationError(errorMessage(cause)),
    },
    queryClient
  )

  useEffect(() => {
    if (!workspaceId) return
    if (currentWorkspace.isPending || activateWorkspace.isPending) return
    if (currentWorkspace.data?.id === workspaceId) return
    activateWorkspace.mutate(workspaceId)
  }, [activateWorkspace, currentWorkspace.data?.id, currentWorkspace.isPending, workspaceId])

  const activeWorkspace = currentWorkspace.data
  const readyWorkspace =
    activeWorkspace?.setupStatus === "ready" ? activeWorkspace : undefined
  const routeMatchesActiveWorkspace =
    !workspaceId || readyWorkspace?.id === workspaceId
  const files = useQuery(
    {
      queryKey: readyWorkspace
        ? workspaceFilesKey(readyWorkspace.id)
        : ["workspace", "files", "disabled"],
      queryFn: () => listFiles(desktop),
      enabled: Boolean(readyWorkspace && routeMatchesActiveWorkspace),
    },
    queryClient
  )
  useEffect(() => {
    return desktop.wiki.onIngestChanged((event) => {
      queryClient.setQueryData<readonly WorkspaceListItem[]>(
        workspacesKey,
        (items) =>
          items?.map((workspace) =>
            workspace.id === event.workspaceId
              ? { ...workspace, running: event.job.status === "running" }
              : workspace
          )
      )
      if (event.job.status !== "running") {
        void queryClient.invalidateQueries({
          queryKey: workspaceFilesKey(event.workspaceId),
        })
      }
    })
  }, [desktop, queryClient])

  const resolvingRouteWorkspace = Boolean(
    workspaceId && !readyWorkspace && !activateWorkspace.isError
  )
  const opening =
    currentWorkspace.isPending || workspaces.isPending || resolvingRouteWorkspace
  const busy: WorkspaceBusy = openWorkspace.isPending
    ? "open"
    : activateWorkspace.isPending
      ? "switch"
      : files.isPending && files.fetchStatus !== "idle"
        ? "files"
        : null
  const error =
    operationError ??
    queryErrorMessage(currentWorkspace.error) ??
    queryErrorMessage(workspaces.error) ??
    queryErrorMessage(files.error)

  return {
    opening,
    workspace: readyWorkspace,
    workspaces: workspaces.data ?? [],
    files: files.data ?? [],
    selectedPath,
    busy,
    error,
    openWorkspace: async () => (await openWorkspace.mutateAsync())?.id ?? null,
  }
}

function WorkspaceRuntimeContent({
  desktop,
  session,
  noWorkspaceElement,
}: {
  desktop: AmendApi
  session: WorkspaceSession
  noWorkspaceElement?: ReactNode
}) {
  const {
    opening,
    workspace,
    workspaces,
    files,
    selectedPath,
    busy,
    error,
    openWorkspace,
  } = session

  if (opening) {
    return <WorkspaceOpening />
  }

  if (!workspace) {
    if (error) return <WorkspaceLoadError message={error} />
    if (noWorkspaceElement) return noWorkspaceElement
    return <WorkspaceNotReady />
  }

  return (
    <WorkspaceViewContext.Provider value={{ desktop, workspace, busy, error }}>
      <WorkspaceShell
        sidebar={
          <WorkspaceSidebar
            workspace={workspace}
            workspaces={workspaces}
            files={files}
            selectedPath={selectedPath}
            busy={busy}
            onOpenWorkspace={openWorkspace}
          />
        }
      >
        <Outlet />
      </WorkspaceShell>
    </WorkspaceViewContext.Provider>
  )
}

export function WorkspaceEmptyContent() {
  const { workspace, busy, error } = useWorkspaceView()
  return <WorkspaceMain workspace={workspace} busy={busy} error={error} />
}

export function WorkspaceFileContent() {
  const { desktop, workspace, busy, error } = useWorkspaceView()
  const { workspaceId, filePath } = useWorkspaceRouteSelection()
  const queryClient = useRouter().options.context.queryClient
  const selectedFile = useQuery(
    {
      queryKey:
        workspaceId && filePath
          ? workspaceFileKey(workspaceId, filePath)
          : ["workspace", "file", "disabled"],
      queryFn: () => readFile(desktop, filePath ?? ""),
      enabled: Boolean(filePath && workspace.id === workspaceId),
    },
    queryClient
  )
  const fileBusy = selectedFile.isFetching ? "file" : busy
  const fileError = error ?? queryErrorMessage(selectedFile.error)

  return (
    <WorkspaceMain
      workspace={workspace}
      selectedFile={selectedFile.data}
      busy={fileBusy}
      error={fileError}
    />
  )
}

function useWorkspaceView(): WorkspaceViewContextValue {
  const value = useContext(WorkspaceViewContext)
  if (!value) throw new Error("Workspace route content must render inside WorkspaceApp")
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
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar collapsible="offcanvas">
          {sidebar}
          <SidebarRail />
        </Sidebar>
        <SidebarInset>{children}</SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

function WorkspaceSidebar({
  workspace,
  workspaces,
  files,
  selectedPath,
  busy,
  onOpenWorkspace,
}: {
  workspace: WorkspaceSummary
  workspaces: readonly WorkspaceListItem[]
  files: readonly WikiFileTreeItem[]
  selectedPath?: string
  busy: WorkspaceBusy
  onOpenWorkspace: () => Promise<string | null>
}) {
  return (
    <>
      <SidebarHeader>
        <WorkspacePicker
          workspace={workspace}
          workspaces={workspaces}
          switching={busy === "switch"}
        />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Files</SidebarGroupLabel>
          <SidebarGroupContent>
            {busy === "files" ? (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                <Spinner />
                <span>Loading files</span>
              </div>
            ) : files.length ? (
              <FileTree
                workspaceId={workspace.id}
                files={files}
                selectedPath={selectedPath}
              />
            ) : (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                No visible files yet.
              </p>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <OpenWorkspaceButton
          opening={busy === "open"}
          onOpenWorkspace={onOpenWorkspace}
        />
      </SidebarFooter>
    </>
  )
}

function WorkspacePicker({
  workspace,
  workspaces,
  switching,
}: {
  workspace: WorkspaceSummary
  workspaces: readonly WorkspaceListItem[]
  switching: boolean
}) {
  const navigate = useNavigate()

  return (
    <label className="relative flex flex-col gap-1 text-xs font-medium text-sidebar-foreground/70">
      Workspace
      <select
        className="h-9 w-full appearance-none rounded-md border border-sidebar-border bg-sidebar-accent px-2.5 pr-8 text-xs font-medium text-sidebar-accent-foreground shadow-xs outline-none transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:bg-sidebar-accent/80 focus-visible:ring-2 focus-visible:ring-sidebar-ring/40 disabled:opacity-50"
        value={workspace.id}
        disabled={switching || workspaces.length < 2}
        onChange={(event) => {
          void navigate({
            to: "/workspace/$workspaceId",
            params: { workspaceId: event.target.value },
          })
        }}
      >
        {workspaces.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
            {item.running ? " - running" : ""}
          </option>
        ))}
      </select>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-3 bottom-3.5 size-1.5 rotate-45 border-r border-b border-sidebar-foreground/60"
      />
    </label>
  )
}

function OpenWorkspaceButton({
  opening,
  onOpenWorkspace,
}: {
  opening: boolean
  onOpenWorkspace: () => Promise<string | null>
}) {
  const navigate = useNavigate()

  async function openWorkspace() {
    const workspaceId = await onOpenWorkspace()
    if (!workspaceId) return
    void navigate({
      to: "/workspace/$workspaceId",
      params: { workspaceId },
    })
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="mt-3 w-full"
      disabled={opening}
      onClick={() => void openWorkspace()}
    >
      {opening ? <Spinner data-icon="inline-start" /> : null}
      Open workspace
    </Button>
  )
}

function WorkspaceMain({
  workspace,
  selectedFile,
  busy,
  error,
}: {
  workspace: WorkspaceSummary
  selectedFile?: WikiFileContent
  busy: WorkspaceBusy
  error?: string
}) {
  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <header className="mb-6 border-b pb-4">
        <SidebarTrigger className="mb-4 md:hidden" />
        <p className="text-xs text-muted-foreground">{workspace.displayPath}</p>
        <h1 className="mt-1 font-heading text-3xl font-medium tracking-tight">
          {selectedFile?.name ?? workspace.name}
        </h1>
      </header>
      <WorkflowError message={error} />
      {busy === "file" ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          <span>Opening file</span>
        </div>
      ) : selectedFile ? (
        <FileViewer file={selectedFile} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Select a file from the sidebar.
        </p>
      )}
    </div>
  )
}

function FileTree({
  workspaceId,
  files,
  selectedPath,
}: {
  workspaceId: string
  files: readonly WikiFileTreeItem[]
  selectedPath?: string
}) {
  return (
    <SidebarMenu>
      <FileTreeItems
        workspaceId={workspaceId}
        files={files}
        selectedPath={selectedPath}
      />
    </SidebarMenu>
  )
}

function FileTreeItems({
  workspaceId,
  files,
  selectedPath,
}: {
  workspaceId: string
  files: readonly WikiFileTreeItem[]
  selectedPath?: string
}) {
  return files.map((file) => (
        <FileTreeRow
          key={file.path}
          workspaceId={workspaceId}
          item={file}
          selectedPath={selectedPath}
        />
  ))
}

function FileTreeRow({
  workspaceId,
  item,
  selectedPath,
}: {
  workspaceId: string
  item: WikiFileTreeItem
  selectedPath?: string
}) {
  if (item.kind === "directory") {
    return (
      <SidebarMenuItem>
        <div className="flex h-8 w-full items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] px-2 text-left text-xs font-medium text-sidebar-foreground/70">
          <span
            aria-hidden="true"
            className="size-1.5 rotate-45 border-r border-b border-sidebar-foreground/45"
          />
          <span className="truncate">{item.name}</span>
        </div>
        {item.children?.length ? (
          <SidebarMenuSub>
            <FileTreeItems
              workspaceId={workspaceId}
              files={item.children}
              selectedPath={selectedPath}
            />
          </SidebarMenuSub>
        ) : null}
      </SidebarMenuItem>
    )
  }
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={
          <Link
            to="/workspace/$workspaceId/$"
            params={{ workspaceId, _splat: item.path }}
          />
        }
        isActive={selectedPath === item.path}
      >
        <span>{item.name}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function FileViewer({ file }: { file: WikiFileContent }) {
  if (file.mediaType === "binary") {
    return (
      <div className="rounded-lg border bg-card p-6 text-card-foreground">
        <p className="text-sm font-medium">Preview unavailable</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {file.name} is a binary file ({file.size} bytes).
        </p>
      </div>
    )
  }
  return (
    <article className="rounded-xl border bg-card text-card-foreground shadow-xs">
      <div className="border-b px-5 py-3 font-mono text-[0.6875rem] text-muted-foreground">
        {file.path} · {file.size} bytes
      </div>
      <div className="overflow-auto whitespace-pre-wrap px-6 py-5 text-[0.9375rem] leading-7 text-foreground">
        {file.content}
      </div>
    </article>
  )
}
