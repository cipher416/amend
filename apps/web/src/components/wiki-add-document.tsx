import type {
  AmendApi,
  SourceDocumentSelection,
  WikiSummary,
} from "@workspace/contract"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { Spinner } from "@workspace/ui/components/spinner"
import { Textarea } from "@workspace/ui/components/textarea"
import { useState } from "react"
import { Controller, useForm } from "react-hook-form"

import { errorMessage } from "@/lib/amend-client"

const documentAccept = {
  "application/pdf": [".pdf"],
  "text/markdown": [".md", ".markdown"],
  "text/plain": [".txt", ".text"],
}

interface AddDocumentFormValues {
  objective: string
}

export function WikiAddDocument({
  desktop,
  wiki,
  running,
}: {
  desktop: AmendApi
  wiki: WikiSummary
  running: boolean
}) {
  const [open, setOpen] = useState(false)
  const [document, setDocument] = useState<SourceDocumentSelection>()
  const [sourceFiles, setSourceFiles] = useState<File[]>()
  const [busy, setBusy] = useState<"registering" | "starting">()
  const [error, setError] = useState<string>()
  const form = useForm<AddDocumentFormValues>({
    defaultValues: { objective: defaultObjective(wiki.domain) },
  })

  function reset() {
    setDocument(undefined)
    setSourceFiles(undefined)
    form.reset({ objective: defaultObjective(wiki.domain) })
    setBusy(undefined)
    setError(undefined)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (busy) return
    setOpen(nextOpen)
    if (!nextOpen) reset()
  }

  async function registerDocument(file: File) {
    setDocument(undefined)
    setSourceFiles([file])
    setBusy("registering")
    setError(undefined)
    try {
      const response = await desktop.wiki.registerDocument(file)
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setDocument(response.value)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(undefined)
    }
  }

  async function startIngest({ objective }: AddDocumentFormValues) {
    if (!document) return

    setBusy("starting")
    setError(undefined)
    try {
      const response = await desktop.wiki.startIngest({
        documentToken: document.token,
        objective,
      })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setOpen(false)
      reset()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <>
      <Button
        type="button"
        className="w-full"
        disabled={running}
        onClick={() => setOpen(true)}
      >
        Add document
      </Button>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" showCloseButton={false}>
          <form
            className="flex h-full flex-col"
            onSubmit={form.handleSubmit(startIngest)}
          >
            <SheetHeader>
              <SheetTitle>Add document</SheetTitle>
              <SheetDescription>
                Add a source for Amend to connect with this wiki.
              </SheetDescription>
            </SheetHeader>
            <FieldGroup className="scroll-fade gap-5 overflow-y-auto px-6 pb-6">
              <Field data-disabled={busy !== undefined || undefined}>
                <FieldLabel htmlFor="source-document">Document</FieldLabel>
                <Dropzone
                  id="source-document"
                  disabled={busy !== undefined}
                  accept={documentAccept}
                  maxFiles={1}
                  maxSize={25 * 1024 * 1024}
                  src={sourceFiles}
                  onDrop={(files) => {
                    if (files.length > 0) void registerDocument(files[0])
                  }}
                  onError={(dropError) => setError(dropError.message)}
                >
                  <DropzoneEmptyState>
                    <div className="flex flex-col items-center justify-center">
                      <p className="text-sm font-medium">Upload a document</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        PDF, Markdown, or text up to 25 MB
                      </p>
                    </div>
                  </DropzoneEmptyState>
                  <DropzoneContent />
                </Dropzone>
              </Field>
              <Controller
                name="objective"
                control={form.control}
                rules={{
                  required:
                    "Describe what Amend should preserve from this document.",
                  validate: (value) =>
                    value.trim().length > 0 ||
                    "Describe what Amend should preserve from this document.",
                }}
                render={({ field, fieldState }) => (
                  <Field
                    data-disabled={busy !== undefined || undefined}
                    data-invalid={fieldState.invalid || undefined}
                  >
                    <FieldLabel htmlFor="source-objective">
                      What matters?
                    </FieldLabel>
                    <Textarea
                      {...field}
                      id="source-objective"
                      aria-invalid={fieldState.invalid}
                      maxLength={10000}
                      rows={4}
                      disabled={busy !== undefined}
                    />
                    <FieldDescription>
                      Refine the default guidance if this source needs special
                      focus.
                    </FieldDescription>
                    {fieldState.invalid ? (
                      <FieldError errors={[fieldState.error]} />
                    ) : null}
                  </Field>
                )}
              />
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
            <SheetFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy !== undefined}
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy !== undefined || !document}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {busy === "registering"
                  ? "Preparing"
                  : busy === "starting"
                    ? "Starting"
                    : "Add to wiki"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </>
  )
}

function defaultObjective(domain: string): string {
  return `Capture concepts, evidence, and tradeoffs relevant to ${domain}.`
}
