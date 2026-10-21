/**
 * The snapshot normaliser.
 *
 * This is where a payload becomes the state the components read, and where
 * a renamed field becomes a screen full of zeros with nothing in the
 * console. The test runs against the *committed* snapshot, so it breaks
 * when the payload changes and nobody updated the client.
 */

import { describe, expect, it } from 'vitest'

import snapshot from '../../../snapshot.json'
import { snapshotToState } from './api'
import type { Snapshot } from './types'

const payload = snapshot as unknown as Snapshot

describe('snapshotToState', () => {
  const state = snapshotToState(payload)

  it('reads the envelope of every payload', () => {
    expect(state.baseCurrency).toBe('EUR')
    expect(state.apiVersion).toBeTruthy()
    expect(state.analytics).not.toBeNull()
  })

  it('maps the summary fields the masthead and KPI band read', () => {
    const summary = state.analytics?.summary
    expect(summary).toBeDefined()
    expect(typeof summary?.total_value).toBe('number')
    expect(summary?.total_value).toBeGreaterThan(0)
    expect(summary?.holdings_count).toBe(state.positions.length)
    expect(summary?.changes.day.pct).toBeTypeOf('number')
    expect(summary?.sparkline.values.length).toBeGreaterThan(0)
  })

  it('maps the risk fields the panels read', () => {
    const risk = state.analytics?.risk
    expect(risk?.lookback_days).toBeGreaterThan(0)
    expect(risk?.sharpe_ratio).toBeTypeOf('number')
    expect(risk?.max_drawdown.pct).toBeLessThanOrEqual(0)
    expect(risk?.benchmark.symbol).toBeTruthy()
    expect(risk?.value_at_risk['95']).toBeDefined()
    expect(risk?.value_at_risk['95']?.cvar_value).toBeTypeOf('number')
    expect(risk?.risk_contribution.length).toBe(state.positions.length)
  })

  it('maps the returns series with parallel arrays', () => {
    const returns = state.analytics?.returns
    expect(returns?.dates.length).toBe(returns?.daily_pct.length)
    expect(returns?.dates.length).toBe(returns?.cumulative_pct.length)
    expect(returns?.monthly_pct.length).toBeGreaterThan(0)
  })

  it('maps the history series with parallel arrays', () => {
    const history = state.analytics?.history
    expect(history?.dates.length).toBe(history?.portfolio.length)
    expect(history?.dates.length).toBe(history?.drawdown_pct.length)
    expect(Object.keys(history?.per_holding ?? {}).length).toBe(state.positions.length)
  })

  it('derives the editable positions from the priced holdings', () => {
    expect(state.positions.length).toBe(state.analytics?.holdings.holdings.length)
    for (const position of state.positions) {
      expect(position.ticker).toBeTruthy()
      expect(position.quantity).toBeGreaterThan(0)
      expect(position.acquired).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('is read-only in snapshot mode', () => {
    expect(state.editable).toBe(false)
    expect(state.source).toBe('snapshot')
    expect(state.cashFlows).toEqual([])
  })

  it('carries the benchmark and its dividend treatment into the settings', () => {
    expect(state.settings?.benchmark).toBeTruthy()
    expect(typeof state.settings?.benchmark_includes_dividends).toBe('boolean')
  })
})
