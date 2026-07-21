import { useQuery } from "@tanstack/react-query"
import { Navigate, createFileRoute, useRouter } from "@tanstack/react-router"

import { errorMessage, useAmendApi } from "@/lib/amend-client"
import {
  readCurrentWorkspace,
  workspaceCurrentKey,
} from "@/lib/workspace-queries"

export const Route = createFileRoute("/workspace/")({
  component: WorkspaceIndexRoute,
})

function WorkspaceIndexRoute() {
  const desktop = useAmendApi()
  const queryClient = useRouter().options.context.queryClient
  const currentWorkspace = useQuery(
    {
      queryKey: workspaceCurrentKey,
      queryFn: () => readCurrentWorkspace(requireDesktop(desktop)),
      enabled: Boolean(desktop),
    },
    queryClient
  )

  if (desktop === null || currentWorkspace.data === null) return <Navigate to="/" />
  if (currentWorkspace.error) {
    return (
      <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
        <p className="max-w-sm text-sm text-muted-foreground">
          {errorMessage(currentWorkspace.error)}
        </p>
      </main>
    )
  }
  if (currentWorkspace.data) {
    return (
      <Navigate
        to="/workspace/$workspaceId"
        params={{ workspaceId: currentWorkspace.data.id }}
        replace
      />
    )
  }
  return null
}

function requireDesktop<T>(value: T | null | undefined): T {
  if (!value) throw new Error("Amend desktop API is unavailable")
  return value
}
