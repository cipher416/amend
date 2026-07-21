import { Navigate, createFileRoute } from "@tanstack/react-router"

import { WorkspaceApp } from "@/components/workspace-app"

export const Route = createFileRoute("/workspace")({
  component: WorkspaceRoute,
})

function WorkspaceRoute() {
  return <WorkspaceApp noWorkspaceElement={<Navigate to="/" />} />
}
