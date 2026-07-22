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
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Spinner } from "@workspace/ui/components/spinner"
import { Textarea } from "@workspace/ui/components/textarea"
import { Controller, useForm } from "react-hook-form"

import { WorkflowError } from "./wiki-workflow-ui"

const documentAccept = {
  "application/pdf": [".pdf"],
  "text/markdown": [".md", ".markdown"],
  "text/plain": [".txt", ".text"],
}

export interface WikiSetupFormValues {
  wikiName: string
  focus: string
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
  onSubmit: (values: WikiSetupFormValues) => void
}) {
  const form = useForm<WikiSetupFormValues>({
    values: { wikiName: wiki?.name ?? wikiName, focus },
  })

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
    <form className="py-2 sm:py-4" onSubmit={form.handleSubmit(onSubmit)}>
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
          <div className="transition-[opacity,transform] duration-[220ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:duration-150 motion-reduce:ease-out starting:translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0">
            <Controller
              name="wikiName"
              control={form.control}
              rules={
                wikiLocked
                  ? undefined
                  : {
                      required: "Enter a name for this wiki.",
                      validate: (value) =>
                        value.trim().length > 0 ||
                        "Enter a name for this wiki.",
                    }
              }
              render={({ field, fieldState }) => (
                <Field
                  data-disabled={wikiLocked || undefined}
                  data-invalid={fieldState.invalid || undefined}
                >
                  <FieldLabel htmlFor="wiki-name">Wiki name</FieldLabel>
                  <Input
                    {...field}
                    id="wiki-name"
                    autoComplete="off"
                    aria-invalid={fieldState.invalid}
                    onChange={(event) => {
                      field.onChange(event)
                      onFieldChange("wikiName", event.target.value)
                    }}
                    placeholder="Reliability research"
                    maxLength={80}
                    disabled={wikiLocked}
                  />
                  {fieldState.invalid ? (
                    <FieldError errors={[fieldState.error]} />
                  ) : null}
                </Field>
              )}
            />

            <Controller
              name="focus"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="wiki-focus">
                    What should Amend focus on? (optional)
                  </FieldLabel>
                  <Textarea
                    {...field}
                    id="wiki-focus"
                    autoComplete="off"
                    aria-invalid={fieldState.invalid}
                    onChange={(event) => {
                      field.onChange(event)
                      onFieldChange("focus", event.target.value)
                    }}
                    placeholder="Recovery ordering and replication tradeoffs"
                    maxLength={2000}
                    rows={3}
                  />
                  <FieldDescription>
                    Guide what Amend should preserve and connect.
                  </FieldDescription>
                </Field>
              )}
            />
          </div>
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
          disabled={busy || !document || (!wikiLocked && !home)}
        >
          {submitting ? <Spinner data-icon="inline-start" /> : null}
          {submitting ? "Building" : "Build wiki"}
        </Button>
      </div>
    </form>
  )
}
