import type { IngestPastedSourceResult, WikiSummary } from "@workspace/contract"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"

import { WorkflowError } from "./wiki-workflow-ui"

export function WikiReadyStep({
  wiki,
  ingest,
  refreshing,
  error,
  onRetryIndex,
}: {
  wiki?: WikiSummary
  ingest?: IngestPastedSourceResult
  refreshing: boolean
  error?: string
  onRetryIndex: () => void
}) {
  return (
    <section className="py-2 sm:py-4" aria-labelledby="ready-title">
      <header className="max-w-xl">
        <h1
          id="ready-title"
          className="font-heading text-3xl font-medium tracking-tight"
        >
          Wiki ready
        </h1>
        <p className="mt-2 text-sm/relaxed text-muted-foreground">
          {ingest?.summary ?? "Your existing wiki is ready to browse."}
        </p>
      </header>

      <div className="mt-8 flex flex-col gap-5 border-y py-5">
        <dl className="grid gap-3 text-xs sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">Wiki</dt>
            <dd>{wiki?.displayPath ?? "Local wiki"}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">Commit</dt>
            <dd className="font-mono">
              {(ingest?.commitHash ?? wiki?.commitHash ?? "unknown").slice(
                0,
                12
              )}
            </dd>
          </div>
        </dl>

        {ingest?.changedFiles.length ? (
          <div className="flex flex-wrap gap-1">
            {ingest.changedFiles.map((path) => (
              <Badge key={path} variant="secondary">
                {path}
              </Badge>
            ))}
          </div>
        ) : null}

        {ingest?.index.status === "failed" ? (
          <Alert variant="destructive">
            <AlertTitle>Search index unavailable</AlertTitle>
            <AlertDescription>{ingest.index.error.message}</AlertDescription>
          </Alert>
        ) : null}

        <WorkflowError message={error} />
      </div>

      {ingest?.index.status === "failed" ? (
        <div className="mt-6 flex justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={refreshing}
            onClick={onRetryIndex}
          >
            {refreshing ? <Spinner data-icon="inline-start" /> : null}
            {refreshing ? "Refreshing" : "Retry index"}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
