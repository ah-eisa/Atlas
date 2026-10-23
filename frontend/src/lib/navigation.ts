/**
 * The views of the app, grouped the way the primary navigation shows them.
 * Shared by the navigation bar and the previous/next view shortcuts.
 */

import type { ViewKey } from './useHashRoute'

export interface NavView {
  key: ViewKey
  label: string
  /** Views that need an analytics payload are disabled until one exists. */
  needsAnalytics: boolean
}

export interface NavGroup {
  label: string
  views: NavView[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Portfolio',
    views: [
      { key: 'overview', label: 'Overview', needsAnalytics: true },
      { key: 'performance', label: 'Performance', needsAnalytics: true },
      { key: 'risk', label: 'Risk', needsAnalytics: true },
      { key: 'xray', label: 'Lab', needsAnalytics: true },
      { key: 'projection', label: 'Projection', needsAnalytics: true },
    ],
  },
  {
    label: 'Book',
    views: [
      { key: 'holdings', label: 'Holdings', needsAnalytics: false },
      { key: 'trades', label: 'Trades', needsAnalytics: false },
    ],
  },
  {
    label: 'Markets',
    views: [
      { key: 'bonds', label: 'Bonds', needsAnalytics: false },
      { key: 'macro', label: 'Macro & filings', needsAnalytics: false },
      { key: 'options', label: 'Options', needsAnalytics: false },
    ],
  },
  {
    label: 'Sources',
    views: [{ key: 'data', label: 'Data', needsAnalytics: false }],
  },
]

/** Every view in reading order, for previous/next navigation. */
export const NAV_ORDER: NavView[] = NAV_GROUPS.flatMap((group) => group.views)
