import type {
  AmendApi,
  WikiFileTreeItem,
  WikiListItem,
  WikiSummary,
} from "@workspace/contract"
import { isWikiName } from "@workspace/contract"
import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import { Link, useNavigate, useRouter } from "@tanstack/react-router"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  File01Icon,
  Folder01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Badge } from "@workspace/ui/components/badge"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
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
  Field,
  FieldDescription,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
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

import { errorMessage } from "@/lib/amend-client"
import { wikiCurrentKey, wikisKey } from "@/lib/wiki-queries"

import { ThemeMenu } from "./theme"
import { SettingsMenu } from "./settings-menu"
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
  wikiActionsBlocked,
}: {
  desktop: AmendApi
  wiki: WikiSummary
  wikis: readonly WikiListItem[]
  files: readonly WikiFileTreeItem[]
  selectedPath?: string
  switching: boolean
  loadingFiles: boolean
  running: boolean
  wikiActionsBlocked: boolean
}) {
  return (
    <>
      <SidebarHeader>
        <WikiPicker
          desktop={desktop}
          wiki={wiki}
          wikis={wikis}
          switching={switching}
          wikiActionsBlocked={wikiActionsBlocked}
        />
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
        <ThemeMenu settings={<SettingsMenu desktop={desktop} />} />
      </SidebarFooter>
    </>
  )
}

function WikiPicker({
  desktop,
  wiki,
  wikis,
  switching,
  wikiActionsBlocked,
}: {
  desktop: AmendApi
  wiki: WikiSummary
  wikis: readonly WikiListItem[]
  switching: boolean
  wikiActionsBlocked: boolean
}) {
  const navigate = useNavigate()
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  return (
    <>
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
            disabled={wikiActionsBlocked}
            onClick={() => setRenameOpen(true)}
          >
            Rename wiki
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={wikiActionsBlocked}
            onClick={() => setDeleteOpen(true)}
          >
            Move wiki to Trash
          </DropdownMenuItem>
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
      <RenameWikiDialog
        desktop={desktop}
        wiki={wiki}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />
      <DeleteWikiDialog
        desktop={desktop}
        wiki={wiki}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </>
  )
}

function DeleteWikiDialog({
  desktop,
  wiki,
  open,
  onOpenChange,
}: {
  desktop: AmendApi
  wiki: WikiSummary
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const queryClient = useRouter().options.context.queryClient
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()

  function handleOpenChange(nextOpen: boolean) {
    if (submitting && !nextOpen) return
    onOpenChange(nextOpen)
    if (nextOpen) setError(undefined)
  }

  async function handleDelete() {
    if (submitting) return
    setSubmitting(true)
    setError(undefined)
    try {
      const response = await desktop.wikis.delete({ wikiId: wiki.id })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const activeWiki = response.value
      if (activeWiki) {
        await navigate({
          to: "/wiki/$wikiId",
          params: { wikiId: activeWiki.id },
          replace: true,
        })
      } else {
        await navigate({
          to: "/",
          search: { createWiki: false },
          replace: true,
        })
      }
      queryClient.setQueryData(wikiCurrentKey, activeWiki)
      queryClient.setQueryData<readonly WikiListItem[]>(wikisKey, (items) =>
        items
          ?.filter((item) => item.id !== wiki.id)
          .map((item) => ({
            ...item,
            active: item.id === activeWiki?.id,
          }))
      )
      queryClient.removeQueries({ queryKey: ["wiki", wiki.id] })
      void queryClient.invalidateQueries({ queryKey: wikisKey })
      onOpenChange(false)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move wiki to Trash?</DialogTitle>
          <DialogDescription>
            The wiki and its Git history will be moved to your operating
            system&apos;s Trash.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1 rounded-md bg-muted/50 p-3">
          <span className="font-medium">{wiki.name}</span>
          <span className="text-xs break-all text-muted-foreground">
            {wiki.displayPath}
          </span>
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={submitting}
            onClick={() => void handleDelete()}
          >
            {submitting ? <Spinner data-icon="inline-start" /> : null}
            Move to Trash
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RenameWikiDialog({
  desktop,
  wiki,
  open,
  onOpenChange,
}: {
  desktop: AmendApi
  wiki: WikiSummary
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useRouter().options.context.queryClient
  const [name, setName] = useState(wiki.name)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  const valid = isWikiName(name)
  const unchanged = name === wiki.name

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen)
    if (nextOpen) {
      setName(wiki.name)
      setError(undefined)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!valid || unchanged || submitting) return
    setSubmitting(true)
    setError(undefined)
    try {
      const response = await desktop.wikis.rename({
        wikiId: wiki.id,
        name,
      })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const renamed = response.value
      queryClient.setQueryData(wikiCurrentKey, renamed)
      queryClient.setQueryData<readonly WikiListItem[]>(wikisKey, (items) =>
        items?.map((item) =>
          item.id === renamed.id
            ? {
                ...item,
                name: renamed.name,
                displayPath: renamed.displayPath,
              }
            : item
        )
      )
      void queryClient.invalidateQueries({ queryKey: wikisKey })
      onOpenChange(false)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename wiki</DialogTitle>
          <DialogDescription>
            This also changes the wiki&apos;s local folder name.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <Field data-invalid={!valid || undefined}>
            <FieldLabel htmlFor="rename-wiki-name">Wiki name</FieldLabel>
            <Input
              id="rename-wiki-name"
              autoComplete="off"
              autoFocus
              maxLength={80}
              value={name}
              aria-invalid={!valid}
              disabled={submitting}
              onChange={(event) => setName(event.target.value)}
            />
            {!valid ? (
              <FieldDescription>
                Use 1–80 characters without slashes or surrounding spaces.
              </FieldDescription>
            ) : null}
          </Field>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || unchanged || submitting}>
              {submitting ? <Spinner data-icon="inline-start" /> : null}
              Rename
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
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
            <SidebarMenuButton className="[&[data-panel-open]>svg:first-child]:rotate-90" />
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
