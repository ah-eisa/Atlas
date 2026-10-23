/**
 * Bridges the CSS design tokens into the charting libraries.
 *
 * ECharts and Lightweight Charts both need literal colour strings in JS, which
 * would normally mean duplicating the palette. Instead these are read from
 * the live computed styles of `:root`, so `tokens.css` remains the single source
 * of truth: change a token there and every chart follows.
 *
 * The read is cached, because recomputing styles on every chart render would
 * force a needless layout. The cache is keyed on the theme version, so a
 * palette change invalidates it and the charts repaint in the new colours.
 */

import { themeVersion, useTheme } from '../lib/theme'

interface ChartTheme {
  surface: string
  surfaceRaised: string
  line: string
  lineStrong: string
  textPrimary: string
  textSecondary: string
  textTertiary: string
  accent: string
  accentDim: string
  positive: string
  negative: string
  grid: string
  axis: string
  band: string
  bandInner: string
  crosshair: string
  benchmark: string
  categorical: string[]
  sequential: string[]
  vizNegative: string
  fontSans: string
  fontMono: string
}

/** Read one custom property off `:root`. */
function token(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

let cached: ChartTheme | null = null
let cachedVersion = -1

/**
 * The resolved theme. Cached per theme version - tokens are static while a
 * theme is active, and re-reading computed styles per chart render would
 * force needless layout.
 */
export function chartTheme(): ChartTheme {
  const version = themeVersion()
  if (cached && cachedVersion === version) return cached

  cached = {
    surface: token('--surface-panel', '#101215'),
    surfaceRaised: token('--surface-raised', '#191d22'),
    line: token('--line', '#202126'),
    lineStrong: token('--line-strong', '#2c2f36'),
    textPrimary: token('--text-primary', '#e9ebee'),
    textSecondary: token('--text-secondary', '#9ba3ae'),
    textTertiary: token('--text-tertiary', '#6a7280'),
    accent: token('--accent', '#4589ff'),
    accentDim: token('--accent-dim', '#2f5fb0'),
    positive: token('--positive', '#42be65'),
    negative: token('--negative', '#fa4d56'),
    grid: token('--viz-grid', '#1a1d22'),
    axis: token('--viz-axis', '#2a2e35'),
    band: token('--viz-band', '#1d2a3d'),
    bandInner: token('--viz-band-inner', '#274468'),
    crosshair: token('--viz-crosshair', '#5d6673'),
    benchmark: token('--viz-benchmark', '#6a7280'),
    categorical: [
      token('--viz-cat-1', '#7aa5e8'),
      token('--viz-cat-2', '#5b83bd'),
      token('--viz-cat-3', '#446596'),
      token('--viz-cat-4', '#344d72'),
      token('--viz-cat-5', '#2a3c56'),
      token('--viz-cat-6', '#232f42'),
    ],
    sequential: [
      token('--viz-seq-1', '#12161c'),
      token('--viz-seq-2', '#1b2838'),
      token('--viz-seq-3', '#234057'),
      token('--viz-seq-4', '#2c5a7c'),
      token('--viz-seq-5', '#3b7ba8'),
      token('--viz-seq-6', '#59a0d0'),
      token('--viz-seq-7', '#8cc3e8'),
    ],
    vizNegative: token('--viz-negative', '#7a4a52'),
    fontSans: token('--font-sans', "'Instrument Sans', Arial, sans-serif"),
    fontMono: token('--font-mono', "'IBM Plex Mono', monospace"),
  }
  cachedVersion = version
  return cached
}

/**
 * The chart theme, for a component that colours a chart from it.
 *
 * Subscribing to the theme is what makes the component re-render when the
 * theme changes; reading `chartTheme()` alone only picks up a new palette
 * when something else happens to re-render it, which could leave light-theme
 * series on a dark page after a switch.
 */
export function useChartTheme(): ChartTheme {
  useTheme()
  return chartTheme()
}

/**
 * Shared ECharts tooltip styling: flat panel, hairline border, square corners,
 * monospaced figures. Applied to every chart so tooltips are one component.
 */
export function tooltipStyle() {
  const theme = chartTheme()
  return {
    backgroundColor: theme.surfaceRaised,
    borderColor: theme.lineStrong,
    borderWidth: 1,
    padding: [8, 10] as [number, number],
    textStyle: {
      color: theme.textPrimary,
      fontFamily: theme.fontMono,
      fontSize: 11,
    },
    extraCssText: 'border-radius:0;box-shadow:none;',
  }
}

/** Standard axis label styling: small, muted, monospaced. */
export function axisLabelStyle() {
  const theme = chartTheme()
  return {
    color: theme.textTertiary,
    fontFamily: theme.fontMono,
    fontSize: 10,
  }
}
