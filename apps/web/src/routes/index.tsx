import { Navigate, createFileRoute } from "@tanstack/react-router"

import { WikiWorkflow } from "@/components/wiki-workflow"

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    createWiki: search.createWiki === true,
  }),
  component: IndexRoute,
})

function IndexRoute() {
  const { createWiki } = Route.useSearch()
  return (
    <WikiWorkflow
      createWiki={createWiki}
      readyElement={<Navigate to="/wiki" />}
    />
  )
}
