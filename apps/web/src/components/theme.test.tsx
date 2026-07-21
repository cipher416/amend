// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AmendApi } from "@workspace/contract"

import { ThemeProvider, useTheme } from "./theme"

let systemPrefersDark = false
let systemThemeListener: (() => void) | undefined

beforeEach(() => {
  systemPrefersDark = false
  systemThemeListener = undefined
  vi.stubGlobal("localStorage", createStorage())
  document.documentElement.className = ""
  document.documentElement.style.colorScheme = ""
  window.matchMedia = vi.fn(
    () =>
      ({
        get matches() {
          return systemPrefersDark
        },
        addEventListener: vi.fn(
          (_type: string, listener: () => void) =>
            (systemThemeListener = listener)
        ),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList
  )
})

afterEach(() => {
  cleanup()
  delete window.amend
  vi.unstubAllGlobals()
})

describe("theme support", () => {
  it("restores a saved theme preference", async () => {
    localStorage.setItem("amend-theme", "dark")

    renderThemeHarness()

    await waitFor(() => expect(screen.getByText("dark")).toBeTruthy())
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe("dark")
  })

  it("persists selections and follows system changes", async () => {
    const user = userEvent.setup()

    renderThemeHarness()

    await user.click(screen.getByRole("button", { name: "Use dark" }))
    await waitFor(() =>
      expect(localStorage.getItem("amend-theme")).toBe("dark")
    )
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    await user.click(screen.getByRole("button", { name: "Use system" }))
    systemPrefersDark = false
    await act(() => systemThemeListener?.())
    expect(document.documentElement.classList.contains("dark")).toBe(false)

    systemPrefersDark = true
    await act(() => systemThemeListener?.())
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  it("synchronizes selections with Electron's native theme", async () => {
    const setTheme = vi.fn(async () => ({ ok: true as const, value: null }))
    window.amend = {
      appearance: {
        setTheme,
      },
    } as unknown as AmendApi
    const user = userEvent.setup()

    renderThemeHarness()

    await waitFor(() => expect(setTheme).toHaveBeenCalledWith("system"))
    setTheme.mockClear()
    await user.click(screen.getByRole("button", { name: "Use dark" }))

    await waitFor(() => expect(setTheme).toHaveBeenCalledWith("dark"))
  })
})

function renderThemeHarness() {
  return render(
    <ThemeProvider>
      <ThemeHarness />
    </ThemeProvider>
  )
}

function ThemeHarness() {
  const { theme, setTheme } = useTheme()

  return (
    <>
      <output>{theme}</output>
      <button onClick={() => setTheme("dark")}>Use dark</button>
      <button onClick={() => setTheme("system")}>Use system</button>
    </>
  )
}

function createStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  }
}
