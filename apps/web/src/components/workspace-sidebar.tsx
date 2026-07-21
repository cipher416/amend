import type {
  AmendApi,
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
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

import { WorkspaceAddDocument } from "./workspace-add-document"
import { WorkspaceAvatar } from "./workspace-avatar"
import { WorkspaceSearch } from "./workspace-search"
import { ThemeMenu } from "./theme"

export function WorkspaceSidebar({
  desktop,
  workspace,
  workspaces,
  files,
  selectedPath,
  switching,
  loadingFiles,
  running,
}: {
  desktop: AmendApi
  workspace: WorkspaceSummary
  workspaces: readonly WorkspaceListItem[]
  files: readonly WikiFileTreeItem[]
  selectedPath?: string
  switching: boolean
  loadingFiles: boolean
  running: boolean
}) {
  return (
    <>
      <SidebarHeader>
        <WorkspacePicker
          workspace={workspace}
          workspaces={workspaces}
          switching={switching}
        />
        <WorkspaceSearch desktop={desktop} workspace={workspace} />
        <WorkspaceAddDocument
          key={workspace.id}
          desktop={desktop}
          workspace={workspace}
          running={running}
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
        <ThemeMenu />
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
            disabled={switching}
            className="data-[popup-open]:[&>svg:last-child]:rotate-180"
          />
        }
      >
        <WorkspaceAvatar
          workspaceId={workspace.id}
          className="size-6 shrink-0 rounded-md"
        />
        <span>{workspace.name}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className="ml-auto transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup
          value={workspace.id}
          onValueChange={(workspaceId) => {
            void navigate({
              to: "/workspace/$workspaceId",
              params: { workspaceId },
            })
          }}
        >
          <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
          {workspaces.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id}>
              <WorkspaceAvatar
                workspaceId={item.id}
                className="size-5 shrink-0 rounded-sm"
              />
              <span>{item.name}</span>
              {item.running ? (
                <Badge className="mr-4 ml-auto" variant="secondary">
                  Running
                </Badge>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() =>
            void navigate({ to: "/", search: { createWorkspace: true } })
          }
        >
          Create wiki
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
