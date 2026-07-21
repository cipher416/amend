import { createFileRoute } from "@tanstack/react-router"

import { WikiEmptyContent, WikiFileContent } from "@/components/wiki-app"

export const Route = createFileRoute("/wiki/$wikiId/$")({
  component: WikiFileRoute,
})

function WikiFileRoute() {
  const { wikiId, _splat: filePath } = Route.useParams()
  if (!filePath) return <WikiEmptyContent />
  return <WikiFileContent wikiId={wikiId} filePath={filePath} />
}
