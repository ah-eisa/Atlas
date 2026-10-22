/**
 * Lightweight deep-link intent bus for the Command Palette (Ctrl+K).
 *
 * Because views are lazy-loaded via `React.lazy`, a command dispatched from
 * `Ctrl+K` (e.g. "Open NVDA 10-K in SEC EDGAR" or "Run 2008 GFC Stress Test")
 * may target a view that has not mounted yet. Storing the pending intent and
 * broadcasting a window event allows both already-mounted and newly-mounted
 * views to react immediately.
 */

export interface CommandIntent {
  view: string
  tab?: string
  ticker?: string
  form?: 'ALL' | '10-K' | '10-Q' | '8-K' | '4'
  series?: string
  scenarioKey?: string
  timestamp: number
}

let pendingIntent: CommandIntent | null = null
const EVENT_NAME = 'atlas:command-intent'

export function dispatchCommandIntent(intent: Omit<CommandIntent, 'timestamp'>): void {
  const full: CommandIntent = { ...intent, timestamp: Date.now() }
  pendingIntent = full
  window.location.hash = `#/${intent.view}`
  window.dispatchEvent(new CustomEvent<CommandIntent>(EVENT_NAME, { detail: full }))
}

export function consumePendingIntent(view: string): CommandIntent | null {
  if (pendingIntent && pendingIntent.view === view) {
    // Keep valid if dispatched within the last 10 seconds
    if (Date.now() - pendingIntent.timestamp < 10_000) {
      const match = pendingIntent
      pendingIntent = null
      return match
    }
    pendingIntent = null
  }
  return null
}

export function subscribeCommandIntent(
  view: string,
  handler: (intent: CommandIntent) => void,
): () => void {
  const listener = (e: Event) => {
    const custom = e as CustomEvent<CommandIntent>
    if (custom.detail && custom.detail.view === view) {
      pendingIntent = null
      handler(custom.detail)
    }
  }
  window.addEventListener(EVENT_NAME, listener)
  return () => window.removeEventListener(EVENT_NAME, listener)
}
