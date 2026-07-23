import { useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import type {
  AmendApi,
  WikiUpdateActivity,
  WikiUpdateChangedFile,
  WikiUpdateMessage,
  WikiUpdateSession,
} from "@workspace/contract"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Bubble, BubbleContent } from "@workspace/ui/components/bubble"
import { Button } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Message, MessageContent } from "@workspace/ui/components/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@workspace/ui/components/message-scroller"
import { Spinner } from "@workspace/ui/components/spinner"
import { Textarea } from "@workspace/ui/components/textarea"
import { lazy, Suspense, useEffect, useRef, useState } from "react"

import { errorMessage } from "@/lib/amend-client"
import {
  unwrapResult,
  wikiCurrentKey,
  wikiFilesKey,
  wikiUpdateKey,
} from "@/lib/wiki-queries"

const updateSuggestions = [
  "Clarify the argument and tighten the structure.",
  "Find gaps and connect this with related ideas.",
] as const

const MessageResponse = lazy(async () => {
  const module = await import("./ai-elements/message")
  return { default: module.MessageResponse }
})

export function WikiUpdatePanel({
  desktop,
  wikiId,
  contextPath,
  session,
  onClose,
  onApplied,
}: {
  desktop: AmendApi
  wikiId: string
  contextPath?: string
  session: WikiUpdateSession | null
  onClose: () => void
  onApplied: (summary: string) => void
}) {
  const router = useRouter()
  const queryClient = router.options.context.queryClient
  const [draft, setDraft] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [operationError, setOperationError] = useState<string>()
  const [selectedPath, setSelectedPath] = useState<string>()
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const proposal = session?.proposal
  const selectedFile = proposal?.changedFiles.find(
    ({ path }) => path === selectedPath
  )
  const diff = useQuery(
    {
      queryKey:
        session && selectedPath
          ? [
              "wiki",
              wikiId,
              "update",
              session.id,
              "diff",
              selectedPath,
              session.revision,
            ]
          : ["wiki", "update", "diff", "disabled"],
      queryFn: async () =>
        unwrapResult(
          await desktop.wiki.readUpdateDiff({
            sessionId: session!.id,
            path: selectedPath!,
          })
        ),
      enabled: Boolean(session && selectedPath && session.status !== "running"),
    },
    queryClient
  )

  useEffect(() => {
    const files = proposal?.changedFiles ?? []
    setSelectedPath((current) =>
      current && files.some(({ path }) => path === current)
        ? current
        : files[0]?.path
    )
  }, [proposal?.changedFiles])

  async function submitPrompt() {
    const prompt = draft.trim()
    if (!prompt || submitting || session?.status === "running") return
    setSubmitting(true)
    setOperationError(undefined)
    try {
      if (session) {
        unwrapResult(
          await desktop.wiki.continueUpdate({ sessionId: session.id, prompt })
        )
      } else {
        unwrapResult(await desktop.wiki.startUpdate({ prompt, contextPath }))
      }
      setDraft("")
    } catch (error) {
      setOperationError(errorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  async function cancelTurn() {
    if (!session) return
    setOperationError(undefined)
    try {
      unwrapResult(
        await desktop.wiki.cancelUpdateTurn({ sessionId: session.id })
      )
    } catch (error) {
      setOperationError(errorMessage(error))
    }
  }

  async function discardUpdate() {
    if (!session || submitting) return
    setSubmitting(true)
    setOperationError(undefined)
    try {
      unwrapResult(await desktop.wiki.discardUpdate({ sessionId: session.id }))
      setSelectedPath(undefined)
    } catch (error) {
      setOperationError(errorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  async function applyUpdate() {
    if (!session?.proposal || submitting) return
    setSubmitting(true)
    setOperationError(undefined)
    try {
      const result = unwrapResult(
        await desktop.wiki.applyUpdate({ sessionId: session.id })
      )
      queryClient.setQueryData(wikiUpdateKey(wikiId), null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: wikiCurrentKey }),
        queryClient.invalidateQueries({ queryKey: wikiFilesKey(wikiId) }),
        queryClient.invalidateQueries({ queryKey: ["wiki", wikiId, "file"] }),
        queryClient.invalidateQueries({ queryKey: ["wiki", wikiId, "search"] }),
        queryClient.invalidateQueries({ queryKey: ["wiki", wikiId, "tags"] }),
      ])
      if (
        contextPath &&
        result.changedFiles.includes(contextPath) &&
        proposalFileDeleted(session.proposal.changedFiles, contextPath)
      ) {
        await router.navigate({ to: "/wiki/$wikiId", params: { wikiId } })
      }
      onApplied(result.summary)
      onClose()
    } catch (error) {
      setOperationError(errorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  function chooseSuggestion(suggestion: string) {
    setDraft(suggestion)
    composerRef.current?.focus()
  }

  const running = session?.status === "running"
  const visibleError = operationError ?? session?.error?.message
  const statusLabel = updateStatusLabel(session)
  const statusBusy =
    session?.status === "running" || session?.status === "applying"

  return (
    <aside className="flex w-[min(42vw,34rem)] min-w-96 shrink-0 flex-col border-l bg-background">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-sm font-medium">Update wiki</h2>
          <p className="truncate text-[0.6875rem] text-muted-foreground">
            {contextPath ? `Context: ${contextPath}` : "Whole wiki"}
          </p>
        </div>
        <div
          aria-live="polite"
          className="flex shrink-0 items-center gap-1.5 text-[0.625rem] text-muted-foreground"
        >
          {statusBusy ? (
            <Spinner className="size-3" />
          ) : (
            <span
              aria-hidden="true"
              className={`size-1.5 rounded-full ${
                session?.status === "failed"
                  ? "bg-destructive"
                  : proposal
                    ? "bg-emerald-500"
                    : "bg-muted-foreground/50"
              }`}
            />
          )}
          <span>{statusLabel}</span>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </header>

      <MessageScrollerProvider
        autoScroll
        defaultScrollPosition="last-anchor"
        scrollPreviousItemPeek={48}
      >
        <MessageScroller className="flex-1">
          <MessageScrollerViewport aria-label="Wiki update conversation">
            <MessageScrollerContent className="gap-5 px-4 py-5">
              {session ? (
                <>
                  {session.messages.map((message) =>
                    message.role === "assistant" && !message.content ? null : (
                      <MessageScrollerItem
                        key={message.id}
                        messageId={message.id}
                        scrollAnchor={message.role === "user"}
                      >
                        <UpdateMessage message={message} />
                      </MessageScrollerItem>
                    )
                  )}
                  {session.activity.length > 0 ? (
                    <MessageScrollerItem messageId={`activity:${session.id}`}>
                      <UpdateActivity activity={session.activity} />
                    </MessageScrollerItem>
                  ) : null}
                </>
              ) : (
                <MessageScrollerItem className="flex min-h-full">
                  <Empty className="border-0">
                    <EmptyHeader>
                      <EmptyTitle>What should Amend change?</EmptyTitle>
                      <EmptyDescription>
                        Describe the outcome. Amend will work in isolation until
                        you review and apply the result.
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent className="max-w-72 flex-row flex-wrap justify-center">
                      {updateSuggestions.map((suggestion) => (
                        <Button
                          key={suggestion}
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-auto min-h-7 text-wrap"
                          onClick={() => chooseSuggestion(suggestion)}
                        >
                          {suggestion}
                        </Button>
                      ))}
                    </EmptyContent>
                  </Empty>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton aria-label="Scroll to latest message" />
        </MessageScroller>
      </MessageScrollerProvider>

      {proposal ? (
        <section className="max-h-[42%] shrink-0 border-t">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <div>
              <h3 className="text-xs font-medium">Changes</h3>
              <p className="text-[0.6875rem] text-muted-foreground">
                {proposal.changedFiles.length} file
                {proposal.changedFiles.length === 1 ? "" : "s"}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={submitting}
                onClick={discardUpdate}
              >
                Discard
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={submitting || session.status !== "review"}
                onClick={applyUpdate}
              >
                {session.status === "applying" ? <Spinner /> : null}
                Apply
              </Button>
            </div>
          </div>
          <div className="grid h-64 grid-cols-[11rem_minmax(0,1fr)]">
            <div className="overflow-y-auto border-r py-1">
              {proposal.changedFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[0.6875rem] ${
                    selectedPath === file.path
                      ? "bg-muted"
                      : "hover:bg-muted/60"
                  }`}
                  onClick={() => setSelectedPath(file.path)}
                >
                  <span className={changeDot(file.status)} />
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  <span className="text-muted-foreground">
                    +{file.additions} −{file.deletions}
                  </span>
                </button>
              ))}
            </div>
            <div className="min-w-0 overflow-auto bg-muted/20">
              {diff.isFetching ? (
                <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
                  <Spinner /> Loading diff
                </div>
              ) : diff.data ? (
                <UnifiedDiff patch={diff.data.patch} />
              ) : selectedFile ? (
                <p className="p-4 text-xs text-muted-foreground">
                  Select the file again to load its diff.
                </p>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {session && !proposal && !running ? (
        <section className="flex shrink-0 items-center justify-between border-t px-4 py-3">
          <p className="text-xs text-muted-foreground">No file changes</p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={discardUpdate}
            >
              Discard
            </Button>
            <Button type="button" size="sm" disabled>
              Apply
            </Button>
          </div>
        </section>
      ) : null}

      <footer className="shrink-0 border-t bg-background/95 p-3 backdrop-blur-sm">
        {visibleError ? (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{visibleError}</AlertDescription>
          </Alert>
        ) : null}
        <form
          className="rounded-xl border bg-muted/20 p-2 shadow-xs transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20"
          onSubmit={(event) => {
            event.preventDefault()
            void submitPrompt()
          }}
        >
          <Textarea
            ref={composerRef}
            aria-label="Update instructions"
            aria-describedby="update-composer-hint"
            value={draft}
            disabled={running || submitting}
            placeholder={
              running
                ? "Amend is working…"
                : session
                  ? "Refine the update…"
                  : "Describe the change you want…"
            }
            className="max-h-36 min-h-16 border-0 bg-transparent p-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                void submitPrompt()
              }
            }}
          />
          <div className="flex items-center justify-between px-2 pb-1">
            <p
              id="update-composer-hint"
              className="text-[0.625rem] text-muted-foreground"
            >
              {running
                ? "You can stop this turn without discarding the session."
                : "Enter to send · Shift+Enter for newline"}
            </p>
            {running ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={cancelTurn}
              >
                Stop
              </Button>
            ) : (
              <Button
                type="submit"
                size="sm"
                disabled={!draft.trim() || submitting}
              >
                {submitting ? <Spinner /> : null}
                Send
              </Button>
            )}
          </div>
        </form>
      </footer>
    </aside>
  )
}

function UpdateMessage({ message }: { message: WikiUpdateMessage }) {
  return (
    <Message align={message.role === "user" ? "end" : "start"}>
      <MessageContent>
        <Bubble
          align={message.role === "user" ? "end" : "start"}
          variant={message.role === "user" ? "muted" : "ghost"}
          className={message.role === "assistant" ? "w-full" : undefined}
        >
          <BubbleContent
            className={message.role === "assistant" ? "w-full" : undefined}
          >
            {message.role === "assistant" ? (
              <Suspense
                fallback={
                  <span className="whitespace-pre-wrap">{message.content}</span>
                }
              >
                <MessageResponse
                  mode={message.status === "streaming" ? "streaming" : "static"}
                >
                  {message.content}
                </MessageResponse>
              </Suspense>
            ) : (
              message.content
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}

function updateStatusLabel(session: WikiUpdateSession | null) {
  if (!session) return "New update"
  if (session.status === "review" && !session.proposal) return "Ready"

  return {
    running: "Working",
    review: "Ready to review",
    applying: "Applying changes",
    failed: "Update failed",
  }[session.status]
}

function UpdateActivity({
  activity,
}: {
  activity: readonly WikiUpdateActivity[]
}) {
  return (
    <section
      aria-label="Update activity"
      className="rounded-lg border bg-muted/20 px-3 py-2.5"
    >
      <p className="mb-2 text-[0.625rem] font-medium tracking-wide text-muted-foreground uppercase">
        Work log
      </p>
      <div className="flex flex-col gap-1.5">
        {activity.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground"
          >
            {item.status === "running" ? (
              <Spinner className="size-3" />
            ) : (
              <span
                aria-hidden="true"
                className={
                  item.status === "failed"
                    ? "size-1.5 rounded-full bg-destructive"
                    : "size-1.5 rounded-full bg-emerald-500"
                }
              />
            )}
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function UnifiedDiff({ patch }: { patch: string }) {
  return (
    <pre className="min-w-max p-3 font-mono text-[0.6875rem]/5">
      {patch.split("\n").map((line, index) => (
        <div
          key={`${index}:${line}`}
          className={
            line.startsWith("+") && !line.startsWith("+++")
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : line.startsWith("-") && !line.startsWith("---")
                ? "bg-red-500/10 text-red-700 dark:text-red-300"
                : line.startsWith("@@")
                  ? "text-blue-600 dark:text-blue-300"
                  : "text-muted-foreground"
          }
        >
          {line || " "}
        </div>
      ))}
    </pre>
  )
}

function changeDot(status: WikiUpdateChangedFile["status"]) {
  return status === "added"
    ? "size-1.5 rounded-full bg-emerald-500"
    : status === "deleted"
      ? "size-1.5 rounded-full bg-red-500"
      : "size-1.5 rounded-full bg-amber-500"
}

function proposalFileDeleted(
  files: readonly WikiUpdateChangedFile[],
  path: string
) {
  return files.some((file) => file.path === path && file.status === "deleted")
}
