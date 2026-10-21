/**
 * Minimal hash router.
 *
 * The dashboard has six top-level views and no nested routes, so a routing
 * dependency would add more surface than it removes. The hash is the source of
 * truth: navigation is plain links, back/forward work, and a deep link such as
 * `#/risk?source=api` can be pasted into a report or a chat message.
 */

import { startTransition, useCallback, useEffect, useState } from 'react'

export const VIEW_KEYS = [
  'overview',
  'performance',
  'risk',
  'holdings',
  'trades',
  'bonds',
  'projection',
  'data',
] as const

export type ViewKey = (typeof VIEW_KEYS)[number]

const DEFAULT_VIEW: ViewKey = 'overview'

/** Read a view key out of a hash. Exported so it can be tested directly. */
export function parseHash(hash: string): ViewKey {
  const candidate = hash.replace(/^#\/?/, '').split('?')[0].split('/')[0]
  return (VIEW_KEYS as readonly string[]).includes(candidate)
    ? (candidate as ViewKey)
    : DEFAULT_VIEW
}

export function useHashRoute(): [ViewKey, (view: ViewKey) => void] {
  const [view, setView] = useState<ViewKey>(() =>
    typeof window === 'undefined' ? DEFAULT_VIEW : parseHash(window.location.hash),
  )

  useEffect(() => {
    // The views are lazy, so a route change may have to fetch a chunk. Marking
    // the update as a transition lets React keep the current view on screen
    // until the next one is ready, instead of flashing a loading placeholder.
    const onHashChange = () =>
      startTransition(() => setView(parseHash(window.location.hash)))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((next: ViewKey) => {
    const target = `#/${next}`
    if (window.location.hash === target) {
      startTransition(() => setView(next))
      return
    }
    // Assigning the hash pushes a history entry, so Back returns to the
    // previous view without any router bookkeeping.
    window.location.hash = target
  }, [])

  return [view, navigate]
}
