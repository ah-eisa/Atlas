/**
 * The hash router decides which view is on screen, so a mistake here is
 * visible immediately - but only if the parsing is exercised directly.
 */

import { describe, expect, it } from 'vitest'

import { VIEW_KEYS, parseHash } from './useHashRoute'

describe('parseHash', () => {
  it('reads every known view', () => {
    for (const view of VIEW_KEYS) {
      expect(parseHash(`#/${view}`)).toBe(view)
    }
  })

  it('accepts a hash without the leading slash', () => {
    expect(parseHash('#risk')).toBe('risk')
    expect(parseHash('#/risk')).toBe('risk')
  })

  it('ignores a query string and any path after the view', () => {
    expect(parseHash('#/risk?source=api')).toBe('risk')
    expect(parseHash('#/holdings/extra')).toBe('holdings')
  })

  it('falls back to the overview for anything unknown', () => {
    expect(parseHash('')).toBe('overview')
    expect(parseHash('#/nonsense')).toBe('overview')
    expect(parseHash('#/')).toBe('overview')
  })
})
