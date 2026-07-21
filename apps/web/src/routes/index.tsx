import { Navigate, createFileRoute } from "@tanstack/react-router"

import { WikiWorkflow } from "@/components/wiki-workflow"

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    createWorkspace: search.createWorkspace === true,
  }),
  component: IndexRoute,
})

function IndexRoute() {
  const { createWorkspace } = Route.useSearch()
  return (
    <WikiWorkflow
      createWorkspace={createWorkspace}
      readyElement={<Navigate to="/workspace" />}
    />
  )
}
