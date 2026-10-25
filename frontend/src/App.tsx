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
import { Sidebar } from './components/Sidebar'
import { NAV_ORDER } from './lib/navigation'
import { TopBar } from './components/TopBar'
import { WatchlistModal } from './components/WatchlistModal'
import { ApiError, deletePosition, updateBaseCurrency, type DataConfig } from './lib/api'
import { formatDate, formatTimestamp } from './lib/format'
import { useTheme } from './lib/theme'
import { useHashRoute, type ViewKey } from './lib/useHashRoute'
import { usePortfolio } from './lib/usePortfolio'
import type { DataSource, OrderType, PortfolioState, Position } from './lib/types'

// Views are code-split: the shell and the KPI band render without waiting for
// a view's panels and, more importantly, without waiting for the charting
// libraries. Each chunk is fetched the first time its view is opened and
// cached thereafter.
//
// A page opened before a new build was deployed still asks for the old
// chunk names, which no longer exist. Rather than leave a blank page, the
// app reloads once to pick up the new build; a second failure within a
// minute is a real error and is thrown.
const RELOAD_KEY = 'atlas.chunk-reload'

function lazyView<P extends object>(load: () => Promise<{ default: React.ComponentType<P> }>) {
  return lazy(() =>
    load().catch((error: unknown) => {
      let last = 0
      try {
        last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0)
        if (Date.now() - last > 60_000) {
          window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
          window.location.reload()
          return new Promise<{ default: React.ComponentType<P> }>(() => {})
        }
      } catch {
        // Without storage a reload could loop; report the failure instead.
      }
      throw error
    }),
  )
}

const OverviewView = lazyView(() => import('./views/OverviewView'))
const PerformanceView = lazyView(() => import('./views/PerformanceView'))
const RiskView = lazyView(() => import('./views/RiskView'))
const LabView = lazyView(() => import('./views/LabView'))
const ProjectionView = lazyView(() => import('./views/ProjectionView'))
const HoldingsView = lazyView(() => import('./views/HoldingsView'))
const TransactionsView = lazyView(() => import('./views/TransactionsView'))
const FixedIncomeView = lazyView(() => import('./views/FixedIncomeView'))
const MacroSecView = lazyView(() => import('./views/MacroSecView'))
const OptionsView = lazyView(() => import('./views/OptionsView'))
const DataView = lazyView(() => import('./views/DataView'))
const MandateView = lazyView(() => import('./views/MandateView'))
const OversightView = lazyView(() => import('./views/OversightView'))

const SIDEBAR_KEY = 'atlas.sidebar.collapsed'

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

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
  onChangeCurrency,
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
  onChangeCurrency?: (currency: string) => Promise<void>
  children: React.ReactNode
}) {
  const summary = state?.analytics?.summary ?? null
  const health = state?.analytics?.health ?? null
  const { theme } = useTheme()
  const live = config.source === 'api'
  const portfolioName =
    state?.source === 'api'
      ? state.portfolios.find((portfolio) => portfolio.id === state.portfolioId)?.name
      : undefined
  const pricedHoldings = state?.analytics?.holdings?.holdings
  const holdingsInProfit = pricedHoldings
    ? pricedHoldings.filter((holding) => holding.unrealized_pnl >= 0).length
    : undefined
  const medianNextYear = state?.analytics?.montecarlo?.median_value

  // The rail's collapsed state is remembered between visits; on a phone the
  // rail is a drawer instead, closed until asked for.
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value
      try {
        window.localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
      } catch {
        // Storage can be unavailable (private mode); the choice then lasts
        // for this visit only.
      }
      return next
    })
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === '\\') {
        event.preventDefault()
        toggleCollapsed()
      } else if (event.key === 'Escape' && drawerOpen) {
        setDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen])

  return (
    <div
      className={collapsed ? 'app app--rail' : 'app'}
      data-theme={theme}
      data-drawer={drawerOpen ? 'open' : undefined}
    >
      <Sidebar
        view={view}
        analyticsReady={summary !== null}
        holdingsCount={state?.positions.length ?? 0}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        drawerOpen={drawerOpen}
        onCloseDrawer={() => setDrawerOpen(false)}
        live={live}
        portfolios={state?.portfolios ?? []}
        activePortfolioId={state?.portfolioId ?? 1}
        onSelectPortfolio={onSelectPortfolio}
        onCreatePortfolio={onCreatePortfolio}
        onSwitchSource={onSwitchSource ? () => onSwitchSource(live ? 'snapshot' : 'api') : undefined}
        pricesAt={
          health?.prices_fetched_at || summary?.generated_at
            ? formatTimestamp(health?.prices_fetched_at ?? summary?.generated_at ?? '')
            : undefined
        }
      />
      <div className="app__column">
        <TopBar
          summary={summary}
          health={health}
          config={config}
          view={view}
          baseCurrency={state?.baseCurrency ?? '—'}
          refreshing={refreshing}
          onRefresh={onRefresh}
          portfolioName={portfolioName}
          holdingsInProfit={holdingsInProfit}
          medianNextYear={medianNextYear}
          onCreatePortfolio={onCreatePortfolio}
          onAddPosition={onAddPosition}
          onOpenTradeModal={onOpenTradeModal}
          onOpenCommandPalette={onOpenCommandPalette}
          onOpenWatchlist={onOpenWatchlist}
          onOpenCsvImport={onOpenCsvImport}
          onSwitchSource={onSwitchSource}
          onOpenMenu={() => setDrawerOpen(true)}
          onChangeCurrency={onChangeCurrency}
          editable={state?.editable ?? false}
        />
        {children}
        <footer className="footer">
          <span>
            {state?.source === 'snapshot' ? 'Demo portfolio from the snapshot' : 'Your self-hosted portfolio'}.
            Not investment advice. Market data from Yahoo Finance.
          </span>
          <span>
            {state?.apiVersion ? `API ${state.apiVersion}, ` : ''}
            {summary ? `as of ${formatDate(summary.as_of)}, ` : ''}
            built {summary ? formatTimestamp(summary.generated_at) : '—'}
          </span>
        </footer>
      </div>
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

  if (view === 'mandate') {
    return <MandateView state={state} config={config} onReload={onReload} />
  }

  if (view === 'oversight') {
    return <OversightView state={state} config={config} />
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

  // Every figure is restated in the new currency, so the analytics are
  // rebuilt rather than converted on the client.
  const handleChangeCurrency = async (currency: string) => {
    await updateBaseCurrency(config, currency)
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
      onChangeCurrency={data.source === 'api' && data.editable ? handleChangeCurrency : undefined}
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
