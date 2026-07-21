import type {
  WikiFileTreeItem,
  WorkspaceListItem,
  WorkspaceSummary,
} from "@workspace/contract"
import { useEffect, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  File01Icon,
  Folder01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from "@workspace/ui/components/sidebar"
import { Spinner } from "@workspace/ui/components/spinner"

export function WorkspaceSidebar({
  workspace,
  workspaces,
  files,
  selectedPath,
  switching,
  loadingFiles,
  openingWorkspace,
  onOpenWorkspace,
}: {
  workspace: WorkspaceSummary
  workspaces: readonly WorkspaceListItem[]
  files: readonly WikiFileTreeItem[]
  selectedPath?: string
  switching: boolean
  loadingFiles: boolean
  openingWorkspace: boolean
  onOpenWorkspace: () => Promise<string | null>
}) {
  return (
    <>
      <SidebarHeader>
        <WorkspacePicker
          workspace={workspace}
          workspaces={workspaces}
          switching={switching}
        />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Files</SidebarGroupLabel>
          <SidebarGroupContent>
            {loadingFiles ? (
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
          opening={openingWorkspace}
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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            size="lg"
            disabled={switching || workspaces.length < 2}
          />
        }
      >
        <HugeiconsIcon icon={Folder01Icon} />
        <span>{workspace.name}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} className="ml-auto" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={workspace.id}
          onValueChange={(workspaceId) => {
            void navigate({
              to: "/workspace/$workspaceId",
              params: { workspaceId },
            })
          }}
        >
          {workspaces.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id}>
              <span>{item.name}</span>
              {item.running ? (
                <Badge className="mr-4 ml-auto" variant="secondary">
                  Running
                </Badge>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
      <DirectoryTreeRow
        workspaceId={workspaceId}
        item={item}
        selectedPath={selectedPath}
      />
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
        <HugeiconsIcon icon={File01Icon} />
        <span>{item.name}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function DirectoryTreeRow({
  workspaceId,
  item,
  selectedPath,
}: {
  workspaceId: string
  item: WikiFileTreeItem
  selectedPath?: string
}) {
  const containsSelectedFile = selectedPath?.startsWith(`${item.path}/`)
  const [open, setOpen] = useState(Boolean(containsSelectedFile))

  useEffect(() => {
    if (containsSelectedFile) setOpen(true)
  }, [containsSelectedFile, selectedPath])

  return (
    <SidebarMenuItem>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          render={
            <SidebarMenuButton className="[&[data-panel-open]>svg]:rotate-90" />
          }
        >
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            className="transition-transform"
          />
          <HugeiconsIcon icon={Folder01Icon} />
          <span>{item.name}</span>
        </CollapsibleTrigger>
        {item.children?.length ? (
          <CollapsibleContent>
            <SidebarMenuSub>
              <FileTreeItems
                workspaceId={workspaceId}
                files={item.children}
                selectedPath={selectedPath}
              />
            </SidebarMenuSub>
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    </SidebarMenuItem>
  )
}
