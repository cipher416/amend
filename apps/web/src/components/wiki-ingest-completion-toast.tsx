import { Cancel01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Button } from "@workspace/ui/components/button"
import { useCallback, useEffect, useRef, useState } from "react"

import type { WikiIngestCompletionNotice } from "./wiki-session"

const toastDurationMs = 5_000
const toastExitDurationMs = 220

export function WikiIngestCompletionToast({
  notice,
  onDismiss,
}: {
  notice?: WikiIngestCompletionNotice
  onDismiss: (jobId: string) => void
}) {
  const [leaving, setLeaving] = useState(false)
  const exitTimeout = useRef<number | undefined>(undefined)

  const dismiss = useCallback(() => {
    if (!notice || exitTimeout.current !== undefined) return

    setLeaving(true)
    exitTimeout.current = window.setTimeout(() => {
      exitTimeout.current = undefined
      onDismiss(notice.jobId)
    }, toastExitDurationMs)
  }, [notice, onDismiss])

  useEffect(() => {
    if (!notice) {
      setLeaving(false)
      return
    }
    const timeout = window.setTimeout(dismiss, toastDurationMs)
    return () => window.clearTimeout(timeout)
  }, [dismiss, notice])

  useEffect(
    () => () => {
      if (exitTimeout.current !== undefined) {
        window.clearTimeout(exitTimeout.current)
      }
    },
    []
  )

  if (!notice) return null

  return (
    <div
      aria-label="Document added to wiki"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg transition-[opacity,transform] duration-[220ms] ease-[cubic-bezier(0.32,0.72,0,1)] data-[leaving=true]:translate-y-full data-[leaving=true]:opacity-0 motion-reduce:duration-150 motion-reduce:ease-out motion-reduce:data-[leaving=true]:translate-y-0 starting:translate-y-full starting:opacity-0 motion-reduce:starting:translate-y-0"
      data-leaving={leaving}
      role="status"
    >
      <p>Document added to {notice.wikiName}</p>
      <Button
        aria-label="Dismiss document added notification"
        className="-mr-1"
        onClick={dismiss}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <HugeiconsIcon icon={Cancel01Icon} />
      </Button>
    </div>
  )
}
