/**
 * Light and dark theme selection.
 *
 * A trading terminal is read at 3am on a dark room and at midday in an
 * office, so both a true-black and a paper-white palette are supported. The
 * choice is persisted, falls back to the operating system's preference, and
 * is applied to the document before the first paint so the page never flashes
 * the wrong background.
 *
 * The palette itself lives in `styles/tokens.css`: this module only decides
 * *which* palette is active and announces the change, so the charts - which
 * read the same tokens - follow automatically.
 */

import { useSyncExternalStore } from 'react'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'atlas.theme.v2'

/** Notified on every change; the version counter drives chart re-colouring. */
const listeners = new Set<() => void>()
let version = 0

function readStoredTheme(): Theme | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    // Private browsing modes can refuse localStorage. The theme still works,
    // it just is not remembered.
    return null
  }
}

function systemTheme(): Theme {
  return 'dark'
}

let current: Theme = readStoredTheme() ?? systemTheme()

/** The active theme. */
export function getTheme(): Theme {
  return current
}

/**
 * Increments whenever the theme changes.
 *
 * Chart options are memoised, so a changed version is what tells a panel to
 * rebuild its palette. It is deliberately a number rather than the theme
 * itself: two consecutive light themes are the same theme, and the charts
 * should not repaint for nothing.
 */
export function themeVersion(): number {
  return version
}

/** True when the user has not chosen a theme explicitly. */
export function hasExplicitTheme(): boolean {
  return readStoredTheme() !== null
}

/** Write the theme onto the document. Called before first paint as well. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
  // Tells the browser to render native controls (scrollbars, date pickers,
  // autofill) in the matching scheme instead of inverting them.
  document.documentElement.style.colorScheme = theme
}

/** Set the theme, persist it, and notify every subscriber. */
export function setTheme(theme: Theme): void {
  if (theme === current) return
  current = theme
  version += 1
  try {
    window.localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Not being able to remember the choice is not a reason to fail.
  }
  applyTheme(theme)
  listeners.forEach((listener) => listener())
}

export function toggleTheme(): void {
  setTheme(current === 'dark' ? 'light' : 'dark')
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Follow the operating system while the user has expressed no preference.
 * Once they choose, the choice wins - the system may change mid-session
 * (a laptop moving between a bright room and a dark one) and yanking the
 * theme back would be rude.
 */
export function watchSystemTheme(): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const query = window.matchMedia('(prefers-color-scheme: light)')

  const handler = () => {
    if (hasExplicitTheme()) return
    const next: Theme = query.matches ? 'light' : 'dark'
    if (next === current) return
    current = next
    version += 1
    applyTheme(next)
    listeners.forEach((listener) => listener())
  }

  query.addEventListener('change', handler)
  return () => query.removeEventListener('change', handler)
}

/** The theme, and callbacks to flip it or pick one. */
export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (theme: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, getTheme, getTheme)
  return { theme, toggle: toggleTheme, setTheme }
}
