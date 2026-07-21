import { createFileRoute } from "@tanstack/react-router"

import { WikiApp } from "@/components/wiki-app"

export const Route = createFileRoute("/wiki/$wikiId")({
  component: WikiRoute,
})

function WikiRoute() {
  const { wikiId } = Route.useParams()
  return <WikiApp wikiId={wikiId} />
}
