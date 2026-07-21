import { createFileRoute } from "@tanstack/react-router"

import {
  WorkspaceEmptyContent,
  WorkspaceFileContent,
} from "@/components/workspace-app"

export const Route = createFileRoute("/workspace/$workspaceId/$")({
  component: WorkspaceFileRoute,
})

function WorkspaceFileRoute() {
  const { workspaceId, _splat: filePath } = Route.useParams()
  if (!filePath) return <WorkspaceEmptyContent />
  return <WorkspaceFileContent workspaceId={workspaceId} filePath={filePath} />
}
