import type {
  SourceDocumentSelection,
  WikiIngestJob,
  WikiHome,
  WikiSummary,
} from "@workspace/contract"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Dropzone,
  DropzoneContent,
  DropzoneEmptyState,
} from "@workspace/ui/components/dropzone"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Spinner } from "@workspace/ui/components/spinner"
import { Textarea } from "@workspace/ui/components/textarea"

import { WorkflowError } from "./wiki-workflow-ui"

const documentAccept = {
  "application/pdf": [".pdf"],
  "text/markdown": [".md", ".markdown"],
  "text/plain": [".txt", ".text"],
}

export function WikiSetupStep({
  wiki,
  wikiName,
  home,
  document,
  sourceFiles,
  focus,
  job,
  busy,
  submitting,
  error,
  onFieldChange,
  onChooseHome,
  onRegisterDocument,
  onDocumentError,
  onSubmit,
}: {
  wiki?: WikiSummary
  wikiName: string
  home?: WikiHome
  document?: SourceDocumentSelection
  sourceFiles?: File[]
  focus: string
  job?: WikiIngestJob
  busy: boolean
  submitting: boolean
  error?: string
  onFieldChange: (field: "wikiName" | "focus", value: string) => void
  onChooseHome: () => void
  onRegisterDocument: (file: File) => void
  onDocumentError: (message: string) => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  if (job?.status === "running") {
    return (
      <section
        className="flex min-h-[60svh] items-center justify-center py-12 text-center"
        aria-labelledby="build-title"
      >
        <div
          className="flex max-w-sm flex-col items-center"
          role="status"
          aria-live="polite"
        >
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            <Spinner className="size-5 text-muted-foreground motion-reduce:animate-none" />
          </div>
          <h1
            id="build-title"
            className="mt-6 font-heading text-2xl font-medium tracking-tight"
          >
            Building your wiki
          </h1>
          <p className="mt-2 text-sm/relaxed text-muted-foreground">
            We're reading, organizing, and linking your first document. This may
            take a few minutes.
          </p>
        </div>
      </section>
    )
  }

  const wikiLocked = wiki !== undefined
  const sourceReady = wikiLocked || Boolean(home)

  return (
    <form className="py-2 sm:py-4" onSubmit={onSubmit}>
      <header className="mb-8 max-w-xl">
        <h1 className="font-heading text-3xl font-medium tracking-tight">
          Create your wiki
        </h1>
        <p className="mt-2 text-sm/relaxed text-muted-foreground">
          Choose where your wikis live, then add the first document.
        </p>
      </header>

      <FieldGroup className="gap-6">
        <Field data-disabled={busy || undefined}>
          <FieldLabel id="wiki-home-label" htmlFor="wiki-home">
            Wiki home
          </FieldLabel>
          {home ? (
            <p
              id="wiki-home"
              aria-labelledby="wiki-home-label"
              className="flex h-7 items-center rounded-md border border-input bg-muted px-2 text-sm text-muted-foreground"
            >
              <span className="truncate">{home.displayPath}</span>
            </p>
          ) : (
            <Button
              id="wiki-home"
              type="button"
              variant="outline"
              disabled={busy || wikiLocked}
              onClick={onChooseHome}
              className="w-full justify-start"
            >
              <span className="truncate">Choose wiki home</span>
            </Button>
          )}
          <FieldDescription>
            Amend stores each wiki here as a separate folder.
          </FieldDescription>
        </Field>

        <Field data-disabled={busy || !sourceReady || undefined}>
          <FieldLabel htmlFor="source-document">First document</FieldLabel>
          <Dropzone
            id="source-document"
            disabled={busy || !sourceReady}
            accept={documentAccept}
            maxFiles={1}
            maxSize={25_000_000}
            src={sourceFiles}
            onDrop={(files) => {
              if (files.length > 0) onRegisterDocument(files[0])
            }}
            onError={(dropError) => onDocumentError(dropError.message)}
          >
            <DropzoneEmptyState>
              <div className="flex flex-col items-center justify-center">
                <p className="text-sm font-medium">Upload a document</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Drag and drop or click to choose
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  PDF, Markdown, or text up to 25 MB
                </p>
              </div>
            </DropzoneEmptyState>
            <DropzoneContent />
          </Dropzone>
        </Field>

        {document ? (
          <>
            <Field data-disabled={wikiLocked || undefined}>
              <FieldLabel htmlFor="wiki-name">Wiki name</FieldLabel>
              <Input
                id="wiki-name"
                name="wiki-name"
                autoComplete="off"
                value={wiki?.name ?? wikiName}
                onChange={(event) =>
                  onFieldChange("wikiName", event.target.value)
                }
                placeholder="Reliability research"
                required
                maxLength={80}
                disabled={wikiLocked}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="wiki-focus">
                What should Amend focus on? (optional)
              </FieldLabel>
              <Textarea
                id="wiki-focus"
                name="wiki-focus"
                autoComplete="off"
                value={focus}
                onChange={(event) => onFieldChange("focus", event.target.value)}
                placeholder="Recovery ordering and replication tradeoffs"
                maxLength={2000}
                rows={3}
              />
              <FieldDescription>
                Guide what Amend should preserve and connect.
              </FieldDescription>
            </Field>
          </>
        ) : null}

        {job?.error ? (
          <Alert variant="destructive">
            <AlertTitle>Document ingest failed</AlertTitle>
            <AlertDescription>{job.error.message}</AlertDescription>
          </Alert>
        ) : null}
        <WorkflowError message={error} />
      </FieldGroup>

      <div className="mt-8 flex justify-end border-t pt-5">
        <Button
          type="submit"
          size="lg"
          disabled={
            busy || !document || (!wikiLocked && (!home || !wikiName.trim()))
          }
        >
          {submitting ? <Spinner data-icon="inline-start" /> : null}
          {submitting ? "Building" : "Build wiki"}
        </Button>
      </div>
    </form>
  )
}
