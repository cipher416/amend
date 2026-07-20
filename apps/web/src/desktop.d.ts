import type { AmendApi } from "@workspace/contract"

declare global {
  interface Window {
    amend?: AmendApi
  }
}

export {}
