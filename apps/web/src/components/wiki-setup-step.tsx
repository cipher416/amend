import type {
  SourceDocumentSelection,
  WikiIngestJob,
  WorkspaceHome,
  WorkspaceSummary,
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
import { Separator } from "@workspace/ui/components/separator"
import { Spinner } from "@workspace/ui/components/spinner"
import { Textarea } from "@workspace/ui/components/textarea"

import { WorkflowError } from "./wiki-workflow-ui"

const documentAccept = {
  "application/pdf": [".pdf"],
  "text/markdown": [".md", ".markdown"],
  "text/plain": [".txt", ".text"],
}

export function WikiSetupStep({
  workspace,
  wikiName,
  domain,
  home,
  document,
  sourceFiles,
  objective,
  job,
  busy,
  submitting,
  error,
  onFieldChange,
  onChooseHome,
  onRegisterDocument,
  onDocumentError,
  onSubmit,
  onCancel,
}: {
  workspace?: WorkspaceSummary
  wikiName: string
  domain: string
  home?: WorkspaceHome
  document?: SourceDocumentSelection
  sourceFiles?: File[]
  objective: string
  job?: WikiIngestJob
  busy: boolean
  submitting: boolean
  error?: string
  onFieldChange: (
    field: "wikiName" | "domain" | "objective",
    value: string
  ) => void
  onChooseHome: () => void
  onRegisterDocument: (file: File) => void
  onDocumentError: (message: string) => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  onCancel: () => void
}) {
  if (job?.status === "running") {
    return (
      <section className="py-2 sm:py-4" aria-labelledby="build-title">
        <header className="max-w-xl">
          <h1
            id="build-title"
            className="font-heading text-3xl font-medium tracking-tight"
          >
            Building your wiki
          </h1>
          <p className="mt-2 text-sm/relaxed text-muted-foreground">
            {job.title}
          </p>
        </header>

        <div
          className="mt-8 flex items-start gap-3 border-y py-5"
          role="status"
          aria-live="polite"
        >
          <Spinner className="mt-0.5" />
          <div>
            <p className="text-sm font-medium">{job.phase}</p>
            <p className="mt-1 text-xs/relaxed text-muted-foreground">
              {job.message}
            </p>
          </div>
        </div>

        {job.cancellable ? (
          <div className="mt-6 flex justify-end">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        ) : null}
      </section>
    )
  }

  const workspaceLocked = workspace !== undefined
  const sourceReady = workspaceLocked || Boolean(home && wikiName && domain)

  return (
    <form className="py-2 sm:py-4" onSubmit={onSubmit}>
      <header className="mb-10 max-w-xl">
        <h1 className="font-heading text-3xl font-medium tracking-tight">
          Create a knowledge base
        </h1>
        <p className="mt-2 text-sm/relaxed text-muted-foreground">
          Define the workspace and add the first document Amend should turn into
          linked knowledge.
        </p>
      </header>

      <FieldGroup className="gap-8">
        <section aria-labelledby="workspace-fields">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2
              id="workspace-fields"
              className="text-xs font-medium text-muted-foreground"
            >
              Workspace
            </h2>
          </div>
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-disabled={workspaceLocked || undefined}>
                <FieldLabel htmlFor="wiki-name">Workspace name</FieldLabel>
                <Input
                  id="wiki-name"
                  name="workspace-name"
                  autoComplete="off"
                  value={workspace?.name ?? wikiName}
                  onChange={(event) =>
                    onFieldChange("wikiName", event.target.value)
                  }
                  placeholder="Reliability research"
                  required
                  maxLength={80}
                  disabled={workspaceLocked}
                />
              </Field>

              <Field data-disabled={busy || workspaceLocked || undefined}>
                <FieldLabel htmlFor="wiki-home">Amend home</FieldLabel>
                <Button
                  id="wiki-home"
                  type="button"
                  variant="outline"
                  disabled={busy || workspaceLocked}
                  onClick={onChooseHome}
                  className="w-full justify-start"
                >
                  <span className="truncate">
                    {home?.displayPath ??
                      workspace?.displayPath ??
                      "Choose Amend home"}
                  </span>
                </Button>
              </Field>
            </div>

            <Field data-disabled={workspaceLocked || undefined}>
              <FieldLabel htmlFor="wiki-domain">Domain</FieldLabel>
              <Textarea
                id="wiki-domain"
                name="workspace-domain"
                autoComplete="off"
                value={workspace?.domain ?? domain}
                onChange={(event) =>
                  onFieldChange("domain", event.target.value)
                }
                placeholder="Database reliability engineering, with emphasis on recovery and replication."
                required
                maxLength={2000}
                rows={3}
                disabled={workspaceLocked}
              />
            </Field>
          </div>
        </section>

        <Separator />

        <section aria-labelledby="source-fields">
          <h2
            id="source-fields"
            className="mb-4 text-xs font-medium text-muted-foreground"
          >
            Source
          </h2>
          <div className="flex flex-col gap-4">
            <Field data-disabled={busy || !sourceReady || undefined}>
              <FieldLabel htmlFor="source-document">First document</FieldLabel>
              <Dropzone
                id="source-document"
                disabled={busy || !sourceReady}
                accept={documentAccept}
                maxFiles={1}
                maxSize={25 * 1024 * 1024}
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

            <Field>
              <FieldLabel htmlFor="source-objective">What matters?</FieldLabel>
              <Textarea
                id="source-objective"
                name="source-objective"
                autoComplete="off"
                value={objective}
                onChange={(event) =>
                  onFieldChange("objective", event.target.value)
                }
                placeholder="Capture the central concepts, evidence, and important tradeoffs."
                required
                maxLength={10000}
                rows={3}
              />
              <FieldDescription>
                Guide what Amend should preserve and connect from this document.
              </FieldDescription>
            </Field>
          </div>
        </section>

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
            busy ||
            !document ||
            (!workspaceLocked && (!home || !wikiName || !domain))
          }
        >
          {submitting ? <Spinner data-icon="inline-start" /> : null}
          {submitting
            ? workspaceLocked
              ? "Starting"
              : "Creating"
            : workspaceLocked
              ? "Build wiki"
              : "Create wiki"}
        </Button>
      </div>
    </form>
  )
}
