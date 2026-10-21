/**
 * Application shell and view routing.
 *
 * The dashboard is organised as six peer views rather than one very long page.
 * Overview remains the default and keeps the whole-portfolio answer in one
 * screen; the remaining views go deeper without forcing every chart to load on
 * first paint. All data still arrives in one analytics payload, so switching
 * views is instantaneous.
 */

import { useState } from 'react'

import { AllocationPanel } from './components/AllocationPanel'
import { BenchmarkPanel } from './components/BenchmarkPanel'
import { CashFlowEditor } from './components/CashFlowEditor'
import { CorrelationPanel } from './components/CorrelationPanel'
import { DataPanel } from './components/DataPanel'
import { DrawdownPanel } from './components/DrawdownPanel'
import { FxAttributionPanel } from './components/FxAttributionPanel'
import { HoldingsPanel } from './components/HoldingsPanel'
import { KpiStrip } from './components/KpiStrip'
import { MonteCarloPanel, OutcomeDistributionPanel } from './components/MonteCarloPanel'
import { MonthlyReturnsPanel } from './components/MonthlyReturnsPanel'
import { Panel } from './components/Panel'
import { PerformancePanel } from './components/PerformancePanel'
import { PortfolioEditor } from './components/PortfolioEditor'
import { ProjectionNotesPanel } from './components/ProjectionNotesPanel'
import { ReturnsDistributionPanel } from './components/ReturnsDistributionPanel'
import { RiskContributionPanel } from './components/RiskContributionPanel'
import { RiskPanel } from './components/RiskPanel'
import { TopBar } from './components/TopBar'
import { ApiError } from './lib/api'
import { formatDate, formatTimestamp } from './lib/format'
import { useTheme } from './lib/theme'
import { useHashRoute, type ViewKey } from './lib/useHashRoute'
import { usePortfolio } from './lib/usePortfolio'
import type { PortfolioState } from './lib/types'

const ANALYTIC_VIEWS: ViewKey[] = ['overview', 'performance', 'risk', 'projection']

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

function SnapshotHoldingsNotice() {
  return (
    <Panel title="Editing" subtitle="snapshot mode is read-only">
      <div className="snapshot-note">
        <p>
          This view is running from the committed <code>snapshot.json</code>. Positions can
          be inspected but not changed, because a static file has no database behind it.
        </p>
        <p>
          Start the FastAPI service and switch the data source to add positions, refresh
          prices, set the reporting currency, and export the stored portfolio.
        </p>
        <a className="button button--primary" href="?source=api#/holdings">
          Open live API
        </a>
      </div>
    </Panel>
  )
}

function AnalyticsViews({
  state,
  view,
  config,
  onReload,
  onApiKey,
}: {
  state: PortfolioState
  view: ViewKey
  config: ReturnType<typeof usePortfolio>['config']
  onReload: () => void
  onApiKey: (key: string) => void
}) {
  const analytics = state.analytics
  if (!analytics) return null

  const { summary, history, returns, risk, montecarlo, holdings } = analytics
  const currency = summary.base_currency
  const apiKeyRequired = state.settings?.api_key_required ?? false

  switch (view) {
    case 'overview':
      return (
        <main className="app__main">
          <KpiStrip risk={risk} montecarlo={montecarlo} summary={summary} currency={currency} />

          <div className="row row--overview">
            <PerformancePanel
              history={history}
              summary={summary}
              returns={returns}
              currency={currency}
            />
            <AllocationPanel
              byClass={summary.allocation_by_class}
              byRegion={summary.allocation_by_region}
              currency={currency}
            />
          </div>

          <div className="row row--split">
            <BenchmarkPanel risk={risk} />
            <RiskContributionPanel risk={risk} />
          </div>

          <HoldingsPanel
            holdings={holdings.holdings}
            totalValue={holdings.total_value}
            currency={currency}
          />
        </main>
      )

    case 'performance':
      return (
        <main className="app__main">
          <PerformancePanel
            history={history}
            summary={summary}
            returns={returns}
            currency={currency}
          />
          <div className="row row--split">
            <DrawdownPanel history={history} risk={risk} />
            <ReturnsDistributionPanel returns={returns} />
          </div>
          <FxAttributionPanel
            summary={summary}
            holdings={holdings.holdings}
            currency={currency}
          />
          <MonthlyReturnsPanel returns={returns} />
        </main>
      )

    case 'risk':
      return (
        <main className="app__main">
          <div className="row row--split">
            <BenchmarkPanel risk={risk} />
            <RiskContributionPanel risk={risk} />
          </div>
          <div className="row row--risk">
            <RiskPanel risk={risk} currency={currency} />
            <CorrelationPanel
              correlation={risk.correlation}
              lookbackDays={risk.lookback_days}
            />
          </div>
        </main>
      )

    case 'projection':
      return (
        <main className="app__main">
          <KpiStrip risk={risk} montecarlo={montecarlo} summary={summary} currency={currency} />
          <div className="row row--projection">
            <MonteCarloPanel montecarlo={montecarlo} currency={currency} />
            <OutcomeDistributionPanel montecarlo={montecarlo} currency={currency} />
          </div>
          <ProjectionNotesPanel montecarlo={montecarlo} currency={currency} />
        </main>
      )

    case 'holdings':
      return (
        <main className="app__main">
          <HoldingsPanel
            holdings={holdings.holdings}
            totalValue={holdings.total_value}
            currency={currency}
          />
          <AllocationPanel
            byClass={summary.allocation_by_class}
            byRegion={summary.allocation_by_region}
            byCurrency={summary.allocation_by_currency}
            currency={currency}
          />
          {state.editable ? (
            <PortfolioEditor
              positions={state.positions}
              config={config}
              apiKeyRequired={apiKeyRequired}
              baseCurrency={currency}
              onSaved={onReload}
              onApiKey={onApiKey}
            />
          ) : (
            <SnapshotHoldingsNotice />
          )}
          {state.editable ? (
            <CashFlowEditor
              cashFlows={state.cashFlows}
              config={config}
              baseCurrency={currency}
              onSaved={onReload}
              onApiKey={onApiKey}
            />
          ) : null}
        </main>
      )

    default:
      return null
  }
}

export default function App() {
  const [view] = useHashRoute()
  const { data, error, loading, refreshing, config, reload, refresh, setApiKey, clearError } =
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

  const analytics = data.analytics
  const isAnalyticView = ANALYTIC_VIEWS.includes(view)

  // A live API can bootstrap successfully with no analytics (empty portfolio or
  // an upstream data failure). Keep the shell and the editor reachable instead
  // of showing an unrecoverable error page.
  let content: React.ReactNode
  if (view === 'data') {
    content = (
      <DataPanel
        state={data}
        config={config}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        onReload={reload}
        onApiKey={setApiKey}
      />
    )
  } else if (!analytics && view === 'holdings') {
    content = (
      <main className="app__main">
        <Panel title="Holdings" subtitle={`${data.positions.length} stored positions`}>
          <div className="state state--inline">
            <span className="state__kicker">
              {data.positions.length === 0 ? 'Empty portfolio' : 'Pricing unavailable'}
            </span>
            <span className="state__title">
              {data.positions.length === 0
                ? 'Add the first position to build the portfolio'
                : 'Positions are stored, but market data could not be loaded'}
            </span>
            <p className="state__detail">
              {data.error ??
                'The editor is ready. Analytics will appear once the portfolio has at least one position and prices can be fetched.'}
            </p>
          </div>
        </Panel>
        {data.editable ? (
          <PortfolioEditor
            positions={data.positions}
            config={config}
            apiKeyRequired={data.settings?.api_key_required ?? false}
            baseCurrency={data.baseCurrency}
            onSaved={reload}
            onApiKey={setApiKey}
          />
        ) : null}
      </main>
    )
  } else if (!analytics && isAnalyticView) {
    content = <AnalyticsUnavailable state={data} onRetry={reload} />
  } else if (!analytics) {
    content = (
      <main className="app__main">
        <AnalyticsUnavailable state={data} onRetry={reload} />
      </main>
    )
  } else {
    content = (
      <AnalyticsViews
        state={data}
        view={view}
        config={config}
        onReload={reload}
        onApiKey={setApiKey}
      />
    )
  }

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
