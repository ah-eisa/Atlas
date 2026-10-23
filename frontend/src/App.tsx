/**
 * Application shell and view routing.
 *
 * The dashboard is organised as peer views rather than one very long page.
 * Overview remains the default and keeps the whole-portfolio answer in one
 * screen; the remaining views go deeper without forcing every chart to load on
 * first paint. All data still arrives in one analytics payload, so switching
 * views is instantaneous.
 */

import { lazy, Suspense, useEffect, useState } from 'react'

import { CommandPalette } from './components/CommandPalette'
import { CsvImportModal } from './components/CsvImportModal'
import { NewPortfolioModal } from './components/NewPortfolioModal'
import { OrderModal } from './components/OrderModal'
import { PositionModal } from './components/PositionModal'
import { NAV_ORDER } from './lib/navigation'
import { TopBar } from './components/TopBar'
import { WatchlistModal } from './components/WatchlistModal'
import { ApiError, deletePosition, type DataConfig } from './lib/api'
import { formatDate, formatTimestamp } from './lib/format'
import { useTheme } from './lib/theme'
import { useHashRoute, type ViewKey } from './lib/useHashRoute'
import { usePortfolio } from './lib/usePortfolio'
import type { DataSource, OrderType, PortfolioState, Position } from './lib/types'

// Views are code-split: the shell and the KPI band render without waiting for
// a view's panels and, more importantly, without waiting for the charting
// libraries. Each chunk is fetched the first time its view is opened and
// cached thereafter.
const OverviewView = lazy(() => import('./views/OverviewView'))
const PerformanceView = lazy(() => import('./views/PerformanceView'))
const RiskView = lazy(() => import('./views/RiskView'))
const LabView = lazy(() => import('./views/LabView'))
const ProjectionView = lazy(() => import('./views/ProjectionView'))
const HoldingsView = lazy(() => import('./views/HoldingsView'))
const TransactionsView = lazy(() => import('./views/TransactionsView'))
const FixedIncomeView = lazy(() => import('./views/FixedIncomeView'))
const MacroSecView = lazy(() => import('./views/MacroSecView'))
const OptionsView = lazy(() => import('./views/OptionsView'))
const DataView = lazy(() => import('./views/DataView'))

function Shell({
  state,
  view,
  config,
  refreshing,
  onRefresh,
  onSelectPortfolio,
  onCreatePortfolio,
  onAddPosition,
  onOpenTradeModal,
  onOpenCommandPalette,
  onOpenWatchlist,
  onOpenCsvImport,
  onSwitchSource,
  children,
}: {
  state: PortfolioState | null
  view: ViewKey
  config: ReturnType<typeof usePortfolio>['config']
  refreshing: boolean
  onRefresh: () => void
  onSelectPortfolio?: (id: number) => void
  onCreatePortfolio?: () => void
  onAddPosition?: () => void
  onOpenTradeModal?: () => void
  onOpenCommandPalette?: () => void
  onOpenWatchlist?: () => void
  onOpenCsvImport?: () => void
  onSwitchSource?: (source: DataSource) => void
  children: React.ReactNode
}) {
  const summary = state?.analytics?.summary ?? null
  const health = state?.analytics?.health ?? null
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
        portfolios={state?.portfolios}
        activePortfolioId={state?.portfolioId}
        onSelectPortfolio={onSelectPortfolio}
        onCreatePortfolio={onCreatePortfolio}
        onAddPosition={onAddPosition}
        onOpenTradeModal={onOpenTradeModal}
        onOpenCommandPalette={onOpenCommandPalette}
        onOpenWatchlist={onOpenWatchlist}
        onOpenCsvImport={onOpenCsvImport}
        onSwitchSource={onSwitchSource}
        editable={state?.editable ?? false}
      />
      {children}
      <footer className="footer">
        <span>
          {state?.source === 'snapshot' ? 'Demo portfolio (Snapshot)' : 'Self-hosted portfolio'} · not
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
  onSwitchSource,
}: {
  error: Error
  config: ReturnType<typeof usePortfolio>['config']
  onRetry: () => void
  onApiKey: (key: string) => void
  onSwitchSource?: (source: DataSource) => void
}) {
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
            : 'Unable to connect to the portfolio API'}
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
            <button
              type="button"
              className="button"
              onClick={() => onSwitchSource?.('snapshot')}
            >
              Open Demo Snapshot Mode
            </button>
          </div>
        )}

        <p className="state__detail state__detail--muted">
          Snapshot mode reads <code>snapshot.json</code> demo. Live API mode
          expects the FastAPI backend service running at <code>{config.apiBaseUrl}</code>.
        </p>
      </div>
    </main>
  )
}

function AnalyticsUnavailable({
  state,
  onRetry,
  onAddPosition,
  onOpenTradeModal,
}: {
  state: PortfolioState
  onRetry: () => void
  onAddPosition?: () => void
  onOpenTradeModal?: () => void
}) {
  return (
    <main className="app__main">
      <div className="state">
        <span className="state__kicker">Empty Portfolio</span>
        <span className="state__title">
          {state.positions.length === 0 ? 'No positions added yet' : 'Could not build the model'}
        </span>
        <p className="state__detail">
          {state.error ??
            'Execute a BUY trade or add your first investment asset to start monitoring valuations, risk distribution and returns.'}
        </p>
        <div className="state__actions">
          {onOpenTradeModal && state.editable && (
            <button type="button" className="button button--primary" onClick={onOpenTradeModal}>
              + Place Buy Order
            </button>
          )}
          {onAddPosition && state.editable && (
            <button type="button" className="button" onClick={onAddPosition}>
              Add Position Manually
            </button>
          )}
          <a className="button" href="#/holdings">
            Open Holdings
          </a>
          <button type="button" className="button button--quiet" onClick={onRetry}>
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
  onAddPosition,
  onEditPosition,
  onDeletePosition,
  onOpenTradeModal,
  onOpenCsvImport,
  onSwitchSource,
}: {
  state: PortfolioState
  view: ViewKey
  config: DataConfig
  refreshing: boolean
  onReload: () => void
  onRefresh: () => void
  onApiKey: (key: string) => void
  onPortfolio: (id: number) => void
  onAddPosition?: () => void
  onEditPosition?: (position: Position) => void
  onDeletePosition?: (id: number) => Promise<void>
  onOpenTradeModal?: (ticker?: string, type?: OrderType) => void
  onOpenCsvImport?: () => void
  onSwitchSource?: (source: DataSource) => void
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
        onOpenCsvImport={onOpenCsvImport}
      />
    )
  }

  if (view === 'trades') {
    return (
      <TransactionsView
        state={state}
        config={config}
        onReload={onReload}
        onOpenTradeModal={(ticker, type) => onOpenTradeModal?.(ticker, type)}
      />
    )
  }

  if (view === 'bonds') {
    return <FixedIncomeView config={config} />
  }

  if (view === 'macro') {
    return <MacroSecView state={state} config={config} />
  }

  if (view === 'options') {
    return <OptionsView state={state} config={config} />
  }

  if (view === 'holdings') {
    return (
      <HoldingsView
        state={state}
        config={config}
        onReload={onReload}
        onApiKey={onApiKey}
        onAddPosition={onAddPosition}
        onEditPosition={onEditPosition}
        onDeletePosition={onDeletePosition}
        onOpenTradeModal={onOpenTradeModal}
        onSwitchSource={onSwitchSource}
      />
    )
  }

  if (!state.analytics) {
    return (
      <AnalyticsUnavailable
        state={state}
        onRetry={onReload}
        onAddPosition={onAddPosition}
        onOpenTradeModal={onOpenTradeModal}
      />
    )
  }

  switch (view) {
    case 'overview':
      return <OverviewView state={state} config={config} />
    case 'performance':
      return <PerformanceView state={state} />
    case 'risk':
      return <RiskView state={state} config={config} />
    case 'xray':
      return (
        <LabView
          config={config}
          portfolioId={state.portfolioId}
          baseCurrency={state.baseCurrency || 'USD'}
        />
      )
    case 'projection':
      return <ProjectionView state={state} />
    default:
      return (
        <AnalyticsUnavailable
          state={state}
          onRetry={onReload}
          onAddPosition={onAddPosition}
          onOpenTradeModal={onOpenTradeModal}
        />
      )
  }
}

export default function App() {
  const [view, navigate] = useHashRoute()
  const {
    data,
    error,
    loading,
    refreshing,
    config,
    reload,
    refresh,
    setApiKey,
    setSource,
    setPortfolio,
    createPortfolioAndSelect,
    clearError,
  } = usePortfolio()

  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  const [isNewPortfolioOpen, setIsNewPortfolioOpen] = useState(false)
  const [isCsvImportOpen, setIsCsvImportOpen] = useState(false)
  const [isWatchlistOpen, setIsWatchlistOpen] = useState(false)

  const analyticsReady = Boolean(data?.analytics)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setIsCommandPaletteOpen((prev) => !prev)
        return
      }

      // [ and ] step through the views in navigation order. They are
      // ignored while typing, with a modifier held, or while a window is open.
      if (e.key !== '[' && e.key !== ']') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (document.body.classList.contains('has-modal')) return

      const available = NAV_ORDER.filter((item) => analyticsReady || !item.needsAnalytics)
      const index = available.findIndex((item) => item.key === view)
      const step = e.key === ']' ? 1 : -1
      const next = available[(index + step + available.length) % available.length]
      if (next) {
        e.preventDefault()
        navigate(next.key)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [analyticsReady, navigate, view])
  const [positionModal, setPositionModal] = useState<{
    isOpen: boolean
    position: Position | null
  }>({
    isOpen: false,
    position: null,
  })

  const [tradeModal, setTradeModal] = useState<{
    isOpen: boolean
    ticker?: string
    type?: OrderType
  }>({
    isOpen: false,
    type: 'BUY',
  })

  const handleOpenAddPosition = () => {
    setPositionModal({ isOpen: true, position: null })
  }

  const handleOpenEditPosition = (pos: Position) => {
    setPositionModal({ isOpen: true, position: pos })
  }

  const handleClosePositionModal = () => {
    setPositionModal({ isOpen: false, position: null })
  }

  const handleOpenTradeModal = (ticker?: string, type?: OrderType) => {
    setTradeModal({ isOpen: true, ticker, type: type || 'BUY' })
  }

  const handleCloseTradeModal = () => {
    setTradeModal({ isOpen: false })
  }

  const handleCreatePortfolio = async (name: string, baseCurrency: string) => {
    await createPortfolioAndSelect(name, baseCurrency)
    reload()
  }

  const handleDeletePosition = async (id: number) => {
    await deletePosition(config, id)
    reload()
  }

  if (loading && !data) {
    return (
      <Shell
        state={null}
        view={view}
        config={config}
        refreshing={refreshing}
        onRefresh={reload}
        onSwitchSource={setSource}
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
        onSwitchSource={setSource}
      >
        <ErrorState
          error={error ?? new Error('The API returned no data.')}
          config={config}
          onRetry={reload}
          onApiKey={setApiKey}
          onSwitchSource={setSource}
        />
      </Shell>
    )
  }

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
        onAddPosition={handleOpenAddPosition}
        onEditPosition={handleOpenEditPosition}
        onDeletePosition={handleDeletePosition}
        onOpenTradeModal={handleOpenTradeModal}
        onOpenCsvImport={() => setIsCsvImportOpen(true)}
        onSwitchSource={setSource}
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
      onSelectPortfolio={setPortfolio}
      onCreatePortfolio={() => setIsNewPortfolioOpen(true)}
      onAddPosition={handleOpenAddPosition}
      onOpenTradeModal={() => handleOpenTradeModal()}
      onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
      onOpenWatchlist={() => setIsWatchlistOpen(true)}
      onOpenCsvImport={() => setIsCsvImportOpen(true)}
      onSwitchSource={setSource}
    >
      <WarningStrip state={data} error={error} onClearError={clearError} />
      {content}

      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        state={data}
        config={config}
        onNavigate={navigate}
        onOpenTradeModal={handleOpenTradeModal}
        onAddPosition={handleOpenAddPosition}
        onOpenCsvImport={() => setIsCsvImportOpen(true)}
        onOpenWatchlist={() => setIsWatchlistOpen(true)}
        onCreatePortfolio={() => setIsNewPortfolioOpen(true)}
        onSelectPortfolio={setPortfolio}
        onSwitchSource={setSource}
        onRefresh={() => void refresh()}
      />

      <CsvImportModal
        isOpen={isCsvImportOpen}
        onClose={() => setIsCsvImportOpen(false)}
        config={config}
        baseCurrency={data.baseCurrency || 'USD'}
        onImportSuccess={() => {
          reload()
          void refresh()
        }}
      />

      <WatchlistModal
        isOpen={isWatchlistOpen}
        onClose={() => setIsWatchlistOpen(false)}
        config={config}
        portfolioId={data.portfolioId}
        baseCurrency={data.baseCurrency || 'USD'}
        onOpenTradeModal={handleOpenTradeModal}
      />

      <NewPortfolioModal
        isOpen={isNewPortfolioOpen}
        onClose={() => setIsNewPortfolioOpen(false)}
        onSubmit={handleCreatePortfolio}
      />

      <PositionModal
        isOpen={positionModal.isOpen}
        position={positionModal.position}
        config={config}
        baseCurrency={data.baseCurrency || 'USD'}
        onClose={handleClosePositionModal}
        onSaved={reload}
        onDelete={handleDeletePosition}
      />

      <OrderModal
        isOpen={tradeModal.isOpen}
        positions={data.positions}
        config={config}
        baseCurrency={data.baseCurrency || 'USD'}
        initialTicker={tradeModal.ticker}
        initialType={tradeModal.type}
        onClose={handleCloseTradeModal}
        onSaved={reload}
      />
    </Shell>
  )
}
