import type {
  AmendApi,
  SourceDocumentSelection,
  WorkspaceSummary,
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

import { errorMessage } from "@/lib/amend-client"

const documentAccept = {
  "application/pdf": [".pdf"],
  "text/markdown": [".md", ".markdown"],
  "text/plain": [".txt", ".text"],
}

export function WorkspaceAddDocument({
  desktop,
  workspace,
  running,
}: {
  desktop: AmendApi
  workspace: WorkspaceSummary
  running: boolean
}) {
  const [open, setOpen] = useState(false)
  const [document, setDocument] = useState<SourceDocumentSelection>()
  const [sourceFiles, setSourceFiles] = useState<File[]>()
  const [objective, setObjective] = useState(() =>
    defaultObjective(workspace.domain)
  )
  const [busy, setBusy] = useState<"registering" | "starting">()
  const [error, setError] = useState<string>()

  function reset() {
    setDocument(undefined)
    setSourceFiles(undefined)
    setObjective(defaultObjective(workspace.domain))
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

  async function startIngest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!document) return
    if (!objective.trim()) {
      setError("Describe what Amend should preserve from this document.")
      return
    }

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
          <form className="flex h-full flex-col" onSubmit={startIngest}>
            <SheetHeader>
              <SheetTitle>Add document</SheetTitle>
              <SheetDescription>
                Add a source for Amend to connect with this workspace.
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
              <Field data-disabled={busy !== undefined || undefined}>
                <FieldLabel htmlFor="source-objective">
                  What matters?
                </FieldLabel>
                <Textarea
                  id="source-objective"
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                  required
                  maxLength={10000}
                  rows={4}
                  disabled={busy !== undefined}
                />
                <FieldDescription>
                  Refine the default guidance if this source needs special
                  focus.
                </FieldDescription>
              </Field>
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
