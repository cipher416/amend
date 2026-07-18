import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"

export const Route = createFileRoute("/")({ component: App })

function App() {
  const desktop = typeof window === "undefined" ? undefined : window.amend

  return (
    <div className="flex min-h-svh p-6">
      <div className="flex max-w-md min-w-0 flex-col gap-4 text-sm leading-loose">
        <div>
          <h1 className="font-medium">Amend is ready.</h1>
          <p>
            {desktop
              ? `The desktop shell is running on ${desktop.platform}.`
              : "The TanStack Start web scaffold is running."}
          </p>
          <Button className="mt-2">Create workspace</Button>
        </div>
      </div>
    </div>
  )
}
