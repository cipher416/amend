import type { ReactNode } from "react"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"

export function WorkflowShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-svh bg-background text-foreground">
      <section className="mx-auto w-full max-w-2xl px-5 pt-16 pb-10 sm:px-6 sm:pt-24 sm:pb-14">
        {children}
      </section>
    </main>
  )
}

export function WorkflowError({ message }: { message?: string }) {
  return message ? (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  ) : null
}
