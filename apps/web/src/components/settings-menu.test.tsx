// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AmendApi, AmendResult } from "@workspace/contract"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ThemeProvider } from "./theme"

vi.mock("@workspace/ui/components/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
  SheetDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  SheetTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
}))

vi.mock("@workspace/ui/components/sidebar", () => ({
  SidebarMenuButton: ({
    children,
    ...props
  }: React.ComponentProps<"button">) => <button {...props}>{children}</button>,
}))

vi.mock("./pi-connect-step", () => ({
  PiConnectStep: () => <p>Connect a model provider</p>,
  ModelPicker: ({ onChange }: { onChange: (model: string) => void }) => (
    <button type="button" onClick={() => onChange("claude-sonnet-4")}>
      Choose Claude Sonnet
    </button>
  ),
}))

import { SettingsMenu } from "./settings-menu"

describe("settings menu", () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  })

  afterEach(() => {
    cleanup()
  })

  it("shows the configured connection and saves a new default model", async () => {
    const user = userEvent.setup()
    const api = createDesktopApi()

    render(
      <ThemeProvider>
        <SettingsMenu desktop={api} />
      </ThemeProvider>
    )

    await user.click(screen.getByRole("button", { name: "Settings" }))

    expect(await screen.findByText("Connected to anthropic.")).toBeTruthy()
    expect(screen.getByText("claude-haiku-4")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Manage model" }))
    await waitFor(() =>
      expect(api.providers.listModels).toHaveBeenCalledWith({
        provider: "anthropic",
      })
    )

    await user.click(
      screen.getByRole("button", { name: "Choose Claude Sonnet" })
    )
    await user.click(screen.getByRole("button", { name: "Save model" }))

    await waitFor(() =>
      expect(api.providers.setDefaultModel).toHaveBeenCalledWith({
        provider: "anthropic",
        model: "claude-sonnet-4",
      })
    )
  })
})

function createDesktopApi(): AmendApi {
  return {
    providers: {
      status: vi.fn(async () =>
        success({
          configured: true,
          provider: "anthropic",
          model: "claude-haiku-4",
        })
      ),
      listModels: vi.fn(async () =>
        success([{ id: "claude-sonnet-4", name: "Claude Sonnet" }])
      ),
      setDefaultModel: vi.fn(async () => success(null)),
    },
  } as unknown as AmendApi
}

function success<T>(value: T): AmendResult<T> {
  return { ok: true, value }
}
