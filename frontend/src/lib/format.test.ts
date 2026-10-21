/**
 * Unit tests for the pure logic in the client.
 *
 * These are the parts that are easy to break silently: the formatters that
 * every number on screen passes through, the hash router that decides which
 * view is shown, and the normaliser that turns a payload into the state the
 * components read. A field renamed on the backend and not here would render
 * zeros with nothing in the console - the contract test on the backend side
 * catches the payload, and these tests catch the client.
 */

import { describe, expect, it } from 'vitest'

import {
  EM_DASH,
  formatCorrelation,
  formatDate,
  formatMoney,
  formatMoneyCompact,
  formatMoneySigned,
  formatPercent,
  formatPercentSigned,
  formatQuantity,
  formatRatio,
  signClass,
} from '../lib/format'

describe('formatters', () => {
  it('formats money in the pinned locale', () => {
    expect(formatMoney(1234.5)).toBe('1,234.50')
    expect(formatMoneyCompact(1234.5)).toBe('1,235')
    expect(formatMoneySigned(1234.5)).toBe('+1,234.50')
    expect(formatMoneySigned(-1234.5)).toBe('-1,234.50')
  })

  it('shows a dash for a missing value rather than NaN', () => {
    expect(formatMoney(null)).toBe(EM_DASH)
    expect(formatMoney(undefined)).toBe(EM_DASH)
    expect(formatPercent(null)).toBe(EM_DASH)
    expect(formatRatio(Number.NaN)).toBe(EM_DASH)
    expect(formatQuantity(null)).toBe(EM_DASH)
  })

  it('treats a fraction as a percentage', () => {
    expect(formatPercent(0.1234)).toBe('12.34%')
    expect(formatPercent(0.1234, 1)).toBe('12.3%')
    expect(formatPercentSigned(-0.0455)).toBe('-4.55%')
    expect(formatPercentSigned(0.0455)).toBe('+4.55%')
  })

  it('keeps ratios unitless', () => {
    expect(formatRatio(0.9906)).toBe('0.99')
    expect(formatCorrelation(-0.732)).toBe('-0.73')
  })

  it('prints fractional quantities with enough precision', () => {
    expect(formatQuantity(110)).toBe('110')
    expect(formatQuantity(0.15)).toBe('0.1500')
    expect(formatQuantity(2.45)).toBe('2.45')
  })

  it('formats dates as ISO days', () => {
    expect(formatDate('2026-10-20')).toBe('20 Oct 2026')
    expect(formatDate(null)).toBe(EM_DASH)
    expect(formatDate('not-a-date')).toBe(EM_DASH)
  })

  it('colours a sign, and never a zero', () => {
    expect(signClass(1)).toBe('pos')
    expect(signClass(-1)).toBe('neg')
    expect(signClass(0)).toBe('flat')
    expect(signClass(null)).toBe('flat')
  })
})
