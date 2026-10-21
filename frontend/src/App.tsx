/**
 * Application shell and view routing.
 *
 * The dashboard is organised as six peer views rather than one very long page.
 * Overview remains the default and keeps the whole-portfolio answer in one
 * screen; the remaining views go deeper without forcing every chart to load on
 * first paint. All data still arrives in one analytics payload, so switching
 * views is instantaneous.
 */

import { lazy, Suspense, useState } from 'react'

import { TopBar } from './components/TopBar'
import { ApiError, type DataConfig } from './lib/api'
import { formatDate, formatTimestamp } from './lib/format'
import { useTheme } from './lib/theme'
import { useHashRoute, type ViewKey } from './lib/useHashRoute'
import { usePortfolio } from './lib/usePortfolio'
import type { PortfolioState } from './lib/types'

// Views are code-split: the shell and the KPI band render without waiting for
// a view's panels and, more importantly, without waiting for the charting
// libraries. Each chunk is fetched the first time its view is opened and
// cached thereafter.
const OverviewView = lazy(() => import('./views/OverviewView'))
const PerformanceView = lazy(() => import('./views/PerformanceView'))
const RiskView = lazy(() => import('./views/RiskView'))
const ProjectionView = lazy(() => import('./views/ProjectionView'))
const HoldingsView = lazy(() => import('./views/HoldingsView'))
const DataView = lazy(() => import('./views/DataView'))

function Shell({
  state,
  view,
  config,
  refreshing,
  onRefresh,
  children,
}: {
  state: PortfolioState | null
  view: ViewKey
  config: ReturnType<typeof usePortfolio>['config']
  refreshing: boolean
  onRefresh: () => void
  children: React.ReactNode
}) {
  const summary = state?.analytics?.summary ?? null
  const health = state?.analytics?.health ?? null
  // Subscribing here makes the whole shell re-render when the theme changes,
  // which is what lets the panels rebuild their chart palettes.
  const { theme } = useTheme()
  const portfolioName =
    state?.source === 'api'
      ? state.portfolios.find((portfolio) => portfolio.id === state.portfolioId)?.name
      : undefined

  return (
    <div className="app" data-theme={theme}>
      <TopBar
        summary={summary}
        health={health}
        config={config}
        view={view}
        baseCurrency={state?.baseCurrency ?? '—'}
        holdingsCount={state?.positions.length ?? 0}
        refreshing={refreshing}
        onRefresh={onRefresh}
        portfolioName={portfolioName}
      />
      {children}
      <footer className="footer">
        <span>
          {state?.source === 'snapshot' ? 'Demo portfolio' : 'Self-hosted portfolio'} · not
          investment advice · market data via Yahoo Finance
        </span>
        <span>
          {state?.apiVersion ? `API ${state.apiVersion} · ` : ''}
          {summary ? `as of ${formatDate(summary.as_of)} · ` : ''}
          built {summary ? formatTimestamp(summary.generated_at) : '—'}
        </span>
      </footer>
    </div>
  )
}

function LoadingState() {
  return (
    <main className="app__main">
      <div className="state">
        <span className="spinner spinner--large spinner--on" aria-hidden="true" />
        <span className="state__title">Loading portfolio analytics</span>
        <p className="state__detail">
          Restoring the committed snapshot, or building the live model from stored positions.
        </p>
      </div>
    </main>
  )
}

function ErrorState({
  error,
  config,
  onRetry,
  onApiKey,
}: {
  error: Error
  config: ReturnType<typeof usePortfolio>['config']
  onRetry: () => void
  onApiKey: (key: string) => void
}) {
  // A rejected key is a different problem from an unreachable server, and the
  // remedy is different too: one needs a credential, the other needs a
  // running process. Collapsing both into "connection error" sends people
  // looking in the wrong place.
  const unauthorised = error instanceof ApiError && (error.status === 401 || error.status === 403)
  const [key, setKey] = useState('')

  return (
    <main className="app__main">
      <div className="state">
        <span className="state__kicker">
          {unauthorised ? 'Authorisation required' : 'Connection error'}
        </span>
        <span className="state__title">
          {unauthorised
            ? 'This API needs a valid key'
            : 'Unable to load the portfolio'}
        </span>
        <p className="state__detail">{error.message}</p>

        {unauthorised ? (
          <div className="editor__auth">
            <label className="field">
              <span className="field__label">API key</span>
              <input
                className="input"
                type="password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="X-API-Key"
                autoComplete="off"
              />
            </label>
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                onApiKey(key.trim())
                onRetry()
              }}
              disabled={!key.trim()}
            >
              Apply key
            </button>
          </div>
        ) : (
          <div className="state__actions">
            <button type="button" className="button button--primary" onClick={onRetry}>
              Retry
            </button>
            <a className="button" href="?source=api#/data">
              Try live API
            </a>
            <a className="text-button" href="?source=snapshot#/data">
              Use demo snapshot
            </a>
          </div>
        )}

        <p className="state__detail state__detail--muted">
          Snapshot mode reads <code>snapshot.json</code> beside the application. API mode
          expects the FastAPI service on <code>{config.apiBaseUrl}</code>.
        </p>
      </div>
    </main>
  )
}

function AnalyticsUnavailable({ state, onRetry }: { state: PortfolioState; onRetry: () => void }) {
  return (
    <main className="app__main">
      <div className="state">
        <span className="state__kicker">Analytics unavailable</span>
        <span className="state__title">
          {state.positions.length === 0 ? 'No positions yet' : 'Could not build the model'}
        </span>
        <p className="state__detail">
          {state.error ??
            'Add a position to create the first portfolio, then the analytics will build from its acquisition date.'}
        </p>
        <div className="state__actions">
          <a className="button button--primary" href="#/holdings">
            Open holdings
          </a>
          <button type="button" className="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      </div>
    </main>
  )
}

function WarningStrip({
  state,
  error,
  onClearError,
}: {
  state: PortfolioState
  error: Error | null
  onClearError: () => void
}) {
  return (
    <>
      {state.warnings.length > 0 ? (
        <div className="banner banner--warning">
          <span className="banner__label">Data warning</span>
          <span className="banner__message">{state.warnings[0]}</span>
          <a className="banner__action" href="#/data">
            Review provenance
          </a>
        </div>
      ) : null}
      {error ? (
        <div className="banner banner--error">
          <span className="banner__label">Update failed</span>
          <span className="banner__message">{error.message}</span>
          <button type="button" className="banner__action" onClick={onClearError}>
            Dismiss
          </button>
        </div>
      ) : null}
    </>
  )
}

function ViewLoading() {
  return (
    <main className="app__main">
      <div className="state state--inline" role="status">
        <span className="spinner spinner--on" aria-hidden="true" />
        <span className="state__title">Loading view</span>
      </div>
    </main>
  )
}

function ViewContent({
  state,
  view,
  config,
  refreshing,
  onReload,
  onRefresh,
  onApiKey,
  onPortfolio,
}: {
  state: PortfolioState
  view: ViewKey
  config: DataConfig
  refreshing: boolean
  onReload: () => void
  onRefresh: () => void
  onApiKey: (key: string) => void
  onPortfolio: (id: number) => void
}) {
  if (view === 'data') {
    return (
      <DataView
        state={state}
        config={config}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onReload={onReload}
        onApiKey={onApiKey}
        onPortfolio={onPortfolio}
      />
    )
  }

  // Holdings is reachable with no analytics at all: an empty live portfolio
  // still needs its editor, and a pricing failure must not hide the positions
  // that are already stored.
  if (view === 'holdings') {
    return (
      <HoldingsView
        state={state}
        config={config}
        onReload={onReload}
        onApiKey={onApiKey}
      />
    )
  }

  // A live API can bootstrap successfully with no analytics (empty portfolio
  // or an upstream data failure). Keep the shell reachable instead of showing
  // an unrecoverable error page.
  if (!state.analytics) {
    return <AnalyticsUnavailable state={state} onRetry={onReload} />
  }

  switch (view) {
    case 'overview':
      return <OverviewView state={state} config={config} />
    case 'performance':
      return <PerformanceView state={state} />
    case 'risk':
      return <RiskView state={state} config={config} />
    case 'projection':
      return <ProjectionView state={state} />
    default:
      return <AnalyticsUnavailable state={state} onRetry={onReload} />
  }
}

export default function App() {
  const [view] = useHashRoute()
  const { data, error, loading, refreshing, config, reload, refresh, setApiKey, setPortfolio, clearError } =
    usePortfolio()

  if (loading && !data) {
    return (
      <Shell
        state={null}
        view={view}
        config={config}
        refreshing={refreshing}
        onRefresh={reload}
      >
        <LoadingState />
      </Shell>
    )
  }

  if (!data) {
    return (
      <Shell
        state={null}
        view={view}
        config={config}
        refreshing={refreshing}
        onRefresh={reload}
      >
        <ErrorState
          error={error ?? new Error('The API returned no data.')}
          config={config}
          onRetry={reload}
          onApiKey={setApiKey}
        />
      </Shell>
    )
  }

  // Views are resolved lazily; the fallback is a panel-shaped skeleton so the
  // page does not jump when a chunk arrives.
  const content = (
    <Suspense fallback={<ViewLoading />}>
      <ViewContent
        state={data}
        view={view}
        config={config}
        refreshing={refreshing}
        onReload={reload}
        onRefresh={() => void refresh()}
        onApiKey={setApiKey}
        onPortfolio={setPortfolio}
      />
    </Suspense>
  )

  return (
    <Shell
      state={data}
      view={view}
      config={config}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
    >
      <WarningStrip state={data} error={error} onClearError={clearError} />
      {content}
    </Shell>
  )
}
