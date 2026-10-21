/**
 * Data provenance, connection controls, and the methodology note.
 *
 * This is deliberately a first-class view rather than a settings drawer. A
 * serious analytics surface should make it obvious where its numbers came from,
 * when they were fetched, which currency they are reported in, and what the
 * model does not know. In snapshot mode the same view explains why editing is
 * disabled and how to switch to the live API.
 */

import { useState } from 'react'

import {
  ApiError,
  downloadExport,
  updateBaseCurrency,
  type DataConfig,
} from '../lib/api'
import { formatDate, formatPercent, formatTimestamp } from '../lib/format'
import type { PortfolioState } from '../lib/types'
import { Panel } from './Panel'

interface DataPanelProps {
  state: PortfolioState
  config: DataConfig
  refreshing: boolean
  onRefresh: () => void
  onReload: () => void
  onApiKey: (key: string) => void
}

function sourceHref(source: 'snapshot' | 'api'): string {
  const url = new URL(window.location.href)
  url.searchParams.set('source', source)
  url.hash = '#/data'
  return `${url.pathname}${url.search}${url.hash}`
}

export function DataPanel({
  state,
  config,
  refreshing,
  onRefresh,
  onReload,
  onApiKey,
}: DataPanelProps) {
  const [baseCurrency, setBaseCurrency] = useState(state.baseCurrency)
  const [baseSaving, setBaseSaving] = useState(false)
  const [baseError, setBaseError] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exporting, setExporting] = useState<'json' | 'csv' | null>(null)

  const live = state.source === 'api'
  const analytics = state.analytics
  const health = analytics?.health
  const settings = state.settings
  const benchmarkIncludesDividends =
    analytics?.risk.benchmark.includes_dividends ?? settings?.benchmark_includes_dividends ?? true

  const applyBaseCurrency = async (event: React.FormEvent) => {
    event.preventDefault()
    setBaseSaving(true)
    setBaseError(null)
    try {
      await updateBaseCurrency(config, baseCurrency.trim().toUpperCase())
      onReload()
    } catch (cause) {
      setBaseError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBaseSaving(false)
    }
  }

  const saveKey = () => {
    onApiKey(keyDraft.trim())
    setKeyDraft('')
    setKeySaved(true)
    window.setTimeout(() => setKeySaved(false), 2500)
  }

  const runExport = async (format: 'json' | 'csv') => {
    setExporting(format)
    setExportError(null)
    try {
      await downloadExport(config, format)
    } catch (cause) {
      setExportError(
        cause instanceof ApiError && cause.status === 401
          ? 'Export rejected: set a valid API key below.'
          : cause instanceof Error
            ? cause.message
            : String(cause),
      )
    } finally {
      setExporting(null)
    }
  }

  return (
    <div className="data-view">
      <div className="row row--data">
        <Panel title="Provenance" subtitle={live ? 'live API' : 'committed snapshot'}>
          <dl className="metadata metadata--provenance">
            <div>
              <dt>Source</dt>
              <dd>{live ? 'FastAPI + SQLite' : 'snapshot.json (demo)'}</dd>
            </div>
            <div>
              <dt>As of</dt>
              <dd className="num">{formatDate(health?.as_of)}</dd>
            </div>
            <div>
              <dt>Built</dt>
              <dd className="num">{formatTimestamp(health?.generated_at)}</dd>
            </div>
            <div>
              <dt>Prices fetched</dt>
              <dd className="num">{formatTimestamp(health?.prices_fetched_at)}</dd>
            </div>
            <div>
              <dt>Base currency</dt>
              <dd className="num">{state.baseCurrency}</dd>
            </div>
            <div>
              <dt>Positions</dt>
              <dd className="num">{state.positions.length}</dd>
            </div>
            <div>
              <dt>Benchmark</dt>
              <dd>
                {settings?.benchmark_name ?? health?.benchmark ?? '—'}
                {settings?.benchmark ? (
                  <span className="num metadata__sub"> {settings.benchmark}</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>History window</dt>
              <dd className="num">
                {health?.history_start ? formatDate(health.history_start) : '—'} ·{' '}
                {health?.history_days ?? 0} trading days
              </dd>
            </div>
            <div>
              <dt>Return observations</dt>
              <dd className="num">{health?.observations ?? 0}</dd>
            </div>
            <div>
              <dt>API version</dt>
              <dd className="num">{state.apiVersion || '—'}</dd>
            </div>
          </dl>

          {state.warnings.length > 0 ? (
            <div className="notice notice--warning">
              <span className="notice__title">Data warnings</span>
              <ul>
                {state.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {state.error ? (
            <div className="notice notice--error">
              <span className="notice__title">Analytics unavailable</span>
              <p>{state.error}</p>
            </div>
          ) : null}
        </Panel>

        <Panel title="Connection" subtitle={config.apiBaseUrl}>
          <div className="source-switch" role="group" aria-label="Data source">
            <a
              className={
                !live
                  ? 'source-switch__option source-switch__option--active'
                  : 'source-switch__option'
              }
              href={sourceHref('snapshot')}
              aria-current={!live ? 'true' : undefined}
            >
              <span className="source-switch__title">Demo snapshot</span>
              <span className="source-switch__detail">
                Static JSON · read-only · no backend process
              </span>
            </a>
            <a
              className={
                live
                  ? 'source-switch__option source-switch__option--active'
                  : 'source-switch__option'
              }
              href={sourceHref('api')}
              aria-current={live ? 'true' : undefined}
            >
              <span className="source-switch__title">Live API</span>
              <span className="source-switch__detail">
                SQLite positions · editable · price refresh
              </span>
            </a>
          </div>

          <div className="data-actions">
            <button type="button" className="button" onClick={onReload}>
              Reload
            </button>
            <button
              type="button"
              className="button"
              onClick={onRefresh}
              disabled={!live || refreshing}
              title={live ? 'Refetch prices from Yahoo Finance' : 'Not available in snapshot mode'}
            >
              {refreshing ? 'Refreshing' : 'Refresh prices'}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => void runExport('json')}
              disabled={!live || exporting !== null}
            >
              {exporting === 'json' ? 'Exporting' : 'Export JSON'}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => void runExport('csv')}
              disabled={!live || exporting !== null}
            >
              {exporting === 'csv' ? 'Exporting' : 'Export CSV'}
            </button>
          </div>
          {exportError ? <p className="field__error">{exportError}</p> : null}

          {live ? (
            <form className="data-form" onSubmit={(event) => void applyBaseCurrency(event)}>
              <label className="field">
                <span className="field__label">Reporting currency</span>
                <div className="field__inline">
                  <input
                    className="input num"
                    value={baseCurrency}
                    onChange={(event) => setBaseCurrency(event.target.value.toUpperCase())}
                    maxLength={3}
                    aria-invalid={Boolean(baseError)}
                  />
                  <button type="submit" className="button" disabled={baseSaving}>
                    {baseSaving ? 'Updating' : 'Set currency'}
                  </button>
                </div>
                <span className="field__hint">
                  Market values and returns are converted from native currencies. The
                  benchmark return is a local-currency price return.
                </span>
                {baseError ? <span className="field__error">{baseError}</span> : null}
              </label>
            </form>
          ) : (
            <p className="panel-note panel-note--inline">
              Snapshot mode is read-only. Switch to the live API to add positions, refresh
              prices, change the reporting currency, or export the stored portfolio.
            </p>
          )}

          {live ? (
            <div className="data-form">
              <span className="field__label">API key</span>
              <div className="field__inline">
                <input
                  className="input"
                  type="password"
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  placeholder={settings?.api_key_required ? 'Required by this API' : 'Optional'}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="button"
                  onClick={saveKey}
                  disabled={!keyDraft.trim()}
                >
                  Save key
                </button>
              </div>
              <span className="field__hint">
                Sent as the <code>X-API-Key</code> header and stored only in this tab&apos;s
                session storage. Never added to a URL. {keySaved ? 'Key applied.' : ''}
              </span>
              {config.apiKey ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onApiKey('')}
                >
                  Clear stored key
                </button>
              ) : null}
            </div>
          ) : null}
        </Panel>
      </div>

      <Panel title="Methodology & limitations">
        <div className="prose-panel">
          <div>
            <h3>Returns are time-weighted</h3>
            <p>
              Daily portfolio returns are computed from the market value of the positions
              held on each date, adjusted for external cash flows on the day they enter the
              portfolio. Contributions therefore do not count as investment performance.
              The equity line is the growth index scaled to today&apos;s market value;
              the actual value line includes the contribution jumps.
            </p>
            <p>
              The money-weighted return (IRR) is reported alongside it. The two answer
              different questions: the time-weighted return judges the strategy, while the
              IRR judges what the money in the account actually earned. When contributions
              are unevenly timed they diverge, and the gap is the cost of the timing
              decision itself.
            </p>
          </div>
          <div>
            <h3>Positions activate on acquisition</h3>
            <p>
              A holding contributes to the portfolio only from its recorded acquisition
              date. The history starts at the earliest acquisition, not at the start of the
              downloaded price series. This avoids the most common backtest error:
              pretending a position was held before it existed.
            </p>
          </div>
          <div>
            <h3>Risk is historical and backward-looking</h3>
            <p>
              Volatility, beta, VaR, CVaR, drawdown and correlation are estimated from the
              common daily sample of the current holdings ({analytics?.risk.lookback_days ?? 0}{' '}
              trading days). Current weights are applied across the window, so a past
              allocation change is not reconstructed. VaR is a one-day, historical
              quantile; CVaR is the mean loss beyond it.
            </p>
          </div>
          <div>
            <h3>Benchmark comparison</h3>
            <p>
              Alpha is Jensen&apos;s alpha from daily excess returns; tracking error is the
              annualised standard deviation of active returns. Up and down capture compare
              portfolio returns with benchmark returns on benchmark-positive and
              benchmark-negative days. The portfolio&apos;s prices are dividend-adjusted, so
              the benchmark is{' '}
              <strong>{benchmarkIncludesDividends ? 'a total-return index' : 'a price index'}</strong>
              {benchmarkIncludesDividends
                ? ', which includes dividends on the same basis.'
                : ', which excludes dividends. Comparing the two understates alpha by roughly the portfolio’s dividend yield.'}
            </p>
          </div>
          <div>
            <h3>Monte Carlo is not a forecast</h3>
            <p>
              The projection resamples historical daily returns while preserving their
              cross-asset correlation. It cannot anticipate a regime change, a liquidity
              event, tax, fees, or a liability schedule. Percentiles describe the simulated
              distribution only.
            </p>
          </div>
          <div>
            <h3>Demo data</h3>
            <p>
              The committed snapshot is an example portfolio valued with real historical
              market prices from Yahoo Finance as of{' '}
              <span className="num">{formatDate(health?.as_of)}</span>. It is not a live
              trading record, is not investment advice, and must not be read as a track
              record. The risk-free rate used in ratio calculations is{' '}
              <span className="num">{formatPercent(analytics?.risk.risk_free_rate, 1)}</span>.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  )
}
