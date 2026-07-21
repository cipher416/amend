import {
  ComputerIcon,
  Moon02Icon,
  Settings02Icon,
  Sun02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { createContext, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"

const themeStorageKey = "amend-theme"
const themes = ["light", "dark", "system"] as const

type Theme = (typeof themes)[number]

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("system")
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setTheme(readStoredTheme())
    setReady(true)
  }, [])

  useEffect(() => {
    if (!ready) return

    applyTheme(theme)
    try {
      localStorage.setItem(themeStorageKey, theme)
    } catch {
      // Theme selection still works when browser storage is unavailable.
    }
  }, [ready, theme])

  useEffect(() => {
    if (!ready || theme !== "system") return

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const updateSystemTheme = () => applyTheme("system")
    mediaQuery.addEventListener("change", updateSystemTheme)
    return () => mediaQuery.removeEventListener("change", updateSystemTheme)
  }, [ready, theme])

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function ThemeMenu() {
  const { theme, setTheme } = useTheme()

  return (
    <SidebarMenu className="flex-row justify-between">
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                aria-label={`Theme: ${theme}`}
                className="w-auto"
                tooltip={`Theme: ${theme}`}
              />
            }
          >
            <HugeiconsIcon icon={themeIcons[theme]} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value) => {
                if (isTheme(value)) setTheme(value)
              }}
            >
              <DropdownMenuLabel>Theme</DropdownMenuLabel>
              {themes.map((option) => (
                <DropdownMenuRadioItem key={option} value={option}>
                  <span className="capitalize">{option}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          aria-label="Settings"
          className="w-auto"
          tooltip="Settings"
          type="button"
        >
          <HugeiconsIcon icon={Settings02Icon} />
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error("useTheme must be used within a ThemeProvider")
  return value
}

function readStoredTheme(): Theme {
  try {
    const storedTheme = localStorage.getItem(themeStorageKey)
    return isTheme(storedTheme) ? storedTheme : "system"
  } catch {
    return "system"
  }
}

function applyTheme(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.classList.toggle("dark", dark)
  document.documentElement.style.colorScheme = dark ? "dark" : "light"
}

function isTheme(value: string | null): value is Theme {
  return themes.some((theme) => theme === value)
}

const themeIcons = {
  light: Sun02Icon,
  dark: Moon02Icon,
  system: ComputerIcon,
}
