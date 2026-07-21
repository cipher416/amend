import { Navigate, createFileRoute } from "@tanstack/react-router"

import { WikiWorkflow } from "@/components/wiki-workflow"

export const Route = createFileRoute("/")({ component: IndexRoute })

function IndexRoute() {
  return <WikiWorkflow readyElement={<Navigate to="/workspace" />} />
}
