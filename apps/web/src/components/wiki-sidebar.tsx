import type {
  AmendApi,
  WikiFileTreeItem,
  WikiListItem,
  WikiSummary,
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

import { ThemeMenu } from "./theme"
import { WikiAddDocument } from "./wiki-add-document"
import { WikiAvatar } from "./wiki-avatar"
import { WikiSearch } from "./wiki-search"

export function WikiSidebar({
  desktop,
  wiki,
  wikis,
  files,
  selectedPath,
  switching,
  loadingFiles,
  running,
}: {
  desktop: AmendApi
  wiki: WikiSummary
  wikis: readonly WikiListItem[]
  files: readonly WikiFileTreeItem[]
  selectedPath?: string
  switching: boolean
  loadingFiles: boolean
  running: boolean
}) {
  return (
    <>
      <SidebarHeader>
        <WikiPicker wiki={wiki} wikis={wikis} switching={switching} />
        <WikiSearch desktop={desktop} wiki={wiki} />
        <WikiAddDocument
          key={wiki.id}
          desktop={desktop}
          wiki={wiki}
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
                wikiId={wiki.id}
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

function WikiPicker({
  wiki,
  wikis,
  switching,
}: {
  wiki: WikiSummary
  wikis: readonly WikiListItem[]
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
        <WikiAvatar wikiId={wiki.id} className="size-6 shrink-0 rounded-md" />
        <span>{wiki.name}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className="ml-auto transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup
          value={wiki.id}
          onValueChange={(wikiId) => {
            void navigate({ to: "/wiki/$wikiId", params: { wikiId } })
          }}
        >
          <DropdownMenuLabel>Switch wiki</DropdownMenuLabel>
          {wikis.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id}>
              <WikiAvatar
                wikiId={item.id}
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
            void navigate({ to: "/", search: { createWiki: true } })
          }
        >
          Create wiki
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FileTree({
  wikiId,
  files,
  selectedPath,
}: {
  wikiId: string
  files: readonly WikiFileTreeItem[]
  selectedPath?: string
}) {
  return (
    <SidebarMenu>
      <FileTreeItems
        wikiId={wikiId}
        files={files}
        selectedPath={selectedPath}
      />
    </SidebarMenu>
  )
}

function FileTreeItems({
  wikiId,
  files,
  selectedPath,
}: {
  wikiId: string
  files: readonly WikiFileTreeItem[]
  selectedPath?: string
}) {
  return files.map((file) => (
    <FileTreeRow
      key={file.path}
      wikiId={wikiId}
      item={file}
      selectedPath={selectedPath}
    />
  ))
}

function FileTreeRow({
  wikiId,
  item,
  selectedPath,
}: {
  wikiId: string
  item: WikiFileTreeItem
  selectedPath?: string
}) {
  if (item.kind === "directory") {
    return (
      <DirectoryTreeRow
        wikiId={wikiId}
        item={item}
        selectedPath={selectedPath}
      />
    )
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={
          <Link to="/wiki/$wikiId/$" params={{ wikiId, _splat: item.path }} />
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
  wikiId,
  item,
  selectedPath,
}: {
  wikiId: string
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
                wikiId={wikiId}
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
