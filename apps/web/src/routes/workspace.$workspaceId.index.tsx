import { createFileRoute } from "@tanstack/react-router"

import { WorkspaceFileContent } from "@/components/workspace-app"

export const Route = createFileRoute("/workspace/$workspaceId/")({
  component: WorkspaceIndexRoute,
})

function WorkspaceIndexRoute() {
  const { workspaceId } = Route.useParams()
  return <WorkspaceFileContent workspaceId={workspaceId} filePath="index.md" />
}
