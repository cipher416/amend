import { createFileRoute } from "@tanstack/react-router"

import { WikiFileContent } from "@/components/wiki-app"

export const Route = createFileRoute("/wiki/$wikiId/")({
  component: WikiIndexRoute,
})

function WikiIndexRoute() {
  const { wikiId } = Route.useParams()
  return <WikiFileContent wikiId={wikiId} filePath="index.md" />
}
