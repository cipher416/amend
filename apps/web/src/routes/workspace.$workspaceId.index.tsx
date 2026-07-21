import { createFileRoute } from "@tanstack/react-router"

import { WorkspaceEmptyContent } from "@/components/workspace-app"

export const Route = createFileRoute("/workspace/$workspaceId/")({
  component: WorkspaceEmptyContent,
})
