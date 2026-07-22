import { useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import type {
  AmendApi,
  WikiUpdateChangedFile,
  WikiUpdateSession,
} from "@workspace/contract"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"
import { Textarea } from "@workspace/ui/components/textarea"
import { useEffect, useRef, useState } from "react"
import { Streamdown } from "streamdown"

import { errorMessage } from "@/lib/amend-client"
import {
  unwrapResult,
  wikiCurrentKey,
  wikiFilesKey,
  wikiUpdateKey,
} from "@/lib/wiki-queries"

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
  const transcriptRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    const element = transcriptRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [session?.revision])

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

  const running = session?.status === "running"
  const visibleError = operationError ?? session?.error?.message

  return (
    <aside className="flex w-[min(42vw,34rem)] min-w-96 shrink-0 flex-col border-l bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-sm font-medium">Update wiki</h2>
          <p className="truncate text-[0.6875rem] text-muted-foreground">
            {contextPath ? `Context: ${contextPath}` : "Whole wiki"}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </header>

      <div
        ref={transcriptRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-5"
      >
        {session ? (
          <div className="space-y-5">
            {session.messages.map((message) =>
              message.role === "user" ? (
                <div
                  key={message.id}
                  className="ml-8 rounded-2xl border bg-muted/60 px-4 py-3 text-sm/relaxed"
                >
                  {message.content}
                </div>
              ) : message.content ? (
                <Streamdown
                  key={message.id}
                  mode={message.status === "streaming" ? "streaming" : "static"}
                  className="text-sm/relaxed text-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted [&_pre]:p-3"
                >
                  {message.content}
                </Streamdown>
              ) : null
            )}
            {session.activity.length > 0 ? (
              <div className="space-y-1 border-l pl-3">
                {session.activity.map((activity) => (
                  <div
                    key={activity.id}
                    className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground"
                  >
                    {activity.status === "running" ? (
                      <Spinner className="size-3" />
                    ) : (
                      <span
                        className={
                          activity.status === "failed"
                            ? "size-1.5 rounded-full bg-destructive"
                            : "size-1.5 rounded-full bg-emerald-500"
                        }
                      />
                    )}
                    <span>{activity.label}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="grid h-full place-items-center py-10 text-center">
            <div className="max-w-64">
              <p className="font-heading text-lg font-medium">
                What should Amend change?
              </p>
              <p className="mt-2 text-xs/relaxed text-muted-foreground">
                Ask for a precise edit or a wiki-wide reorganization. Changes
                stay isolated until you review and apply them.
              </p>
            </div>
          </div>
        )}
      </div>

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

      <footer className="shrink-0 border-t p-3">
        {visibleError ? (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{visibleError}</AlertDescription>
          </Alert>
        ) : null}
        <div className="rounded-xl border bg-muted/30 p-2 shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
          <Textarea
            aria-label="Update instructions"
            value={draft}
            disabled={running || submitting}
            placeholder={
              session ? "Continue the update…" : "Ask Amend to update the wiki…"
            }
            className="min-h-20 border-0 bg-transparent p-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                void submitPrompt()
              }
            }}
          />
          <div className="flex items-center justify-between px-2 pb-1">
            <p className="text-[0.625rem] text-muted-foreground">
              Enter to send · Shift+Enter for newline
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
                type="button"
                size="sm"
                disabled={!draft.trim() || submitting}
                onClick={submitPrompt}
              >
                {submitting ? <Spinner /> : null}
                Send
              </Button>
            )}
          </div>
        </div>
      </footer>
    </aside>
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
