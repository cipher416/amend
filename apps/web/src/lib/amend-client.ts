import { useSyncExternalStore } from "react"
import type { AmendApi } from "@workspace/contract"

export function getAmendApi(): AmendApi | null {
  return window.amend ?? null
}

export function useAmendApi(): AmendApi | null | undefined {
  return useSyncExternalStore(
    () => () => undefined,
    () => getAmendApi(),
    () => undefined
  )
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Amend could not complete the request."
}
