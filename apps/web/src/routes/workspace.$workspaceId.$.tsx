import { createFileRoute } from "@tanstack/react-router"

import { WorkspaceFileContent } from "@/components/workspace-app"

export const Route = createFileRoute("/workspace/$workspaceId/$")({
  component: WorkspaceFileContent,
})
