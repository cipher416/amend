import { createFileRoute } from "@tanstack/react-router"

import { WorkspaceApp } from "@/components/workspace-app"

export const Route = createFileRoute("/workspace/$workspaceId")({
  component: WorkspaceRoute,
})

function WorkspaceRoute() {
  const { workspaceId } = Route.useParams()
  return <WorkspaceApp workspaceId={workspaceId} />
}
