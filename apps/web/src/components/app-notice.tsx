import { useEffect, useRef, useState } from "react"

const noticeEventName = "amend:notice"

interface Notice {
  message: string
  visible: boolean
}

export function showNotice(message: string): void {
  window.dispatchEvent(
    new CustomEvent(noticeEventName, { detail: { message } })
  )
}

export function AppNotice() {
  const [notice, setNotice] = useState<Notice>()
  const hideTimer = useRef<number | undefined>(undefined)
  const removeTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    function clearTimers() {
      window.clearTimeout(hideTimer.current)
      window.clearTimeout(removeTimer.current)
    }

    function handleNotice(event: Event) {
      if (
        !(event instanceof CustomEvent) ||
        typeof event.detail?.message !== "string"
      ) {
        return
      }
      clearTimers()
      setNotice({ message: event.detail.message, visible: true })
      hideTimer.current = window.setTimeout(() => {
        setNotice((current) =>
          current ? { ...current, visible: false } : current
        )
        removeTimer.current = window.setTimeout(() => setNotice(undefined), 150)
      }, 3_500)
    }

    window.addEventListener(noticeEventName, handleNotice)
    return () => {
      clearTimers()
      window.removeEventListener(noticeEventName, handleNotice)
    }
  }, [])

  if (!notice) return null
  return (
    <div
      role="status"
      aria-live="polite"
      data-visible={notice.visible}
      className="pointer-events-none fixed bottom-4 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-md border bg-popover px-3 py-2 text-center text-sm [overflow-wrap:anywhere] text-popover-foreground shadow-md transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] data-[visible=false]:translate-y-1 data-[visible=false]:opacity-0 data-[visible=false]:duration-150 motion-reduce:duration-150 motion-reduce:data-[visible=false]:translate-y-0 starting:translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0"
    >
      {notice.message}
    </div>
  )
}
