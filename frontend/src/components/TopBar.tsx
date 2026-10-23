/**
 * Application chrome: the market ticker, one toolbar row (wordmark,
 * portfolio switcher, search, actions), the grouped primary navigation, and
 * the headline readout of the portfolio's value.
 *
 * Actions that do not fit on narrower screens move into a More menu rather
 * than disappearing.
 */

import {
  formatDate,
  formatMoneyCompact,
  formatMoneySigned,
  formatPercentSigned,
  formatTimestamp,
  signClass,
} from '../lib/format'
import type { DataConfig } from '../lib/api'
import { useTheme } from '../lib/theme'
import type { DataSource, Health, Portfolio, SummaryPayload } from '../lib/types'
import type { ViewKey } from '../lib/useHashRoute'
import { ActionMenu, type ActionMenuItem } from './ActionMenu'
import { AnimatedNumber } from './AnimatedNumber'
import { AtlasLogo } from './AtlasLogo'
import { MarketTickerBar } from './MarketTickerBar'
import { PrimaryNav } from './PrimaryNav'
import { Sparkline } from './Sparkline'
interface TopBarProps {
  summary: SummaryPayload | null
  health: Health | null
  config: DataConfig
  view: ViewKey
  baseCurrency: string
  holdingsCount: number
  refreshing: boolean
  onRefresh: () => void
  portfolioName?: string
  portfolios?: Portfolio[]
  activePortfolioId?: number
  onSelectPortfolio?: (id: number) => void
  onCreatePortfolio?: () => void
  onAddPosition?: () => void
  onOpenTradeModal?: () => void
  onOpenCommandPalette?: () => void
  onOpenWatchlist?: () => void
  onOpenCsvImport?: () => void
  onSwitchSource?: (source: DataSource) => void
  editable?: boolean
}

interface DeltaProps {
  label: string
  absolute: number | null
  percent: number | null
  delay: number
}

/** One signed change readout: value, percentage, semantic colour. */
function Delta({ label, absolute, percent, delay }: DeltaProps) {
  const tone = signClass(absolute)
  return (
    <div className="topbar__delta">
      <span className="topbar__delta-label">{label}</span>
      <span className={`num ${tone}`}>
        <AnimatedNumber
          value={absolute}
          format={formatMoneySigned}
          delay={delay}
          className={`num ${tone}`}
        />
        {' '}
        <span className="topbar__delta-pct">
          (<AnimatedNumber value={percent} format={formatPercentSigned} delay={delay} />)
        </span>
      </span>
    </div>
  )
}

/** Sun / moon glyph for the theme switch. */
function ThemeIcon({ theme }: { theme: 'dark' | 'light' }) {
  if (theme === 'dark') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3.1" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="square">
          <path d="M8 0.8 V2.6" />
          <path d="M8 13.4 V15.2" />
          <path d="M0.8 8 H2.6" />
          <path d="M13.4 8 H15.2" />
          <path d="M2.9 2.9 L4.1 4.1" />
          <path d="M11.9 11.9 L13.1 13.1" />
          <path d="M13.1 2.9 L11.9 4.1" />
          <path d="M4.1 11.9 L2.9 13.1" />
        </g>
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13.4 9.6A5.8 5.8 0 0 1 6.4 2.6a5.9 5.9 0 1 0 7 7Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function TopBar({
  summary,
  health,
  config,
  view,
  baseCurrency,
  holdingsCount,
  refreshing,
  onRefresh,
  portfolioName,
  portfolios = [],
  activePortfolioId = 1,
  onSelectPortfolio,
  onCreatePortfolio,
  onAddPosition,
  onOpenTradeModal,
  onOpenCommandPalette,
  onOpenWatchlist,
  onOpenCsvImport,
  onSwitchSource,
  editable = false,
}: TopBarProps) {
  const live = config.source === 'api'
  const analyticsReady = summary !== null
  const { theme, toggle } = useTheme()

  const menuItems: ActionMenuItem[] = [
    onOpenWatchlist && { key: 'watchlist', label: 'Watchlist and alerts', onSelect: onOpenWatchlist },
    onOpenCsvImport && { key: 'import', label: 'Import a file', onSelect: onOpenCsvImport },
    editable && onAddPosition && { key: 'add', label: 'Add a position', onSelect: onAddPosition },
    live && onCreatePortfolio && { key: 'new', label: 'New portfolio', onSelect: onCreatePortfolio },
    {
      key: 'refresh',
      label: live ? 'Refresh prices' : 'Reload the snapshot',
      onSelect: onRefresh,
      phoneOnly: true,
    },
    onSwitchSource && {
      key: 'source',
      label: live ? 'Use the demo snapshot' : 'Use the live API',
      onSelect: () => onSwitchSource(live ? 'snapshot' : 'api'),
      phoneOnly: true,
    },
  ].filter(Boolean) as ActionMenuItem[]

  return (
    <header className={analyticsReady ? 'topbar' : 'topbar topbar--compact'}>
      <MarketTickerBar config={config} />

      <div className="topbar__chrome">
        <div className="topbar__brand-group">
          <a className="topbar__brand" href="#/overview" aria-label="ATLAS, go to the overview">
            <AtlasLogo size={22} className="topbar__logo-icon" />
            <span className="topbar__wordmark">ATLAS</span>
          </a>

          {live && portfolios.length > 0 && onSelectPortfolio && (
            <label className="book-switch" title="Switch portfolio">
              <span className="visually-hidden">Portfolio</span>
              <select
                className="book-switch__select"
                value={activePortfolioId}
                onChange={(e) => onSelectPortfolio(Number(e.target.value))}
              >
                {portfolios.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.base_currency}
                  </option>
                ))}
              </select>
            </label>
          )}

          {live && onCreatePortfolio && (
            <button
              type="button"
              className="icon-button topbar__wide-only"
              onClick={onCreatePortfolio}
              aria-label="New portfolio"
              title="New portfolio"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>

        {onOpenCommandPalette && (
          <button
            type="button"
            className="topbar__search"
            onClick={onOpenCommandPalette}
            aria-label="Search and commands"
            aria-keyshortcuts="Control+K"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7.5" />
              <path d="M20.5 20.5 16.5 16.5" />
            </svg>
            <span className="topbar__search-text">Search or run a command</span>
            <span className="topbar__search-keys" aria-hidden="true">
              <kbd className="kbd">Ctrl</kbd>
              <kbd className="kbd">K</kbd>
            </span>
          </button>
        )}

        <div className="topbar__actions">
          {editable && onOpenTradeModal && (
            <button type="button" className="button button--primary button--sm" onClick={onOpenTradeModal}>
              Trade
            </button>
          )}

          {onOpenWatchlist && (
            <button type="button" className="button button--quiet button--sm topbar__wide-only" onClick={onOpenWatchlist}>
              Watchlist
            </button>
          )}

          {onOpenCsvImport && (
            <button type="button" className="button button--quiet button--sm topbar__wide-only" onClick={onOpenCsvImport}>
              Import
            </button>
          )}

          {editable && onAddPosition && (
            <button type="button" className="button button--quiet button--sm topbar__wide-only" onClick={onAddPosition}>
              Add position
            </button>
          )}

          <ActionMenu label="More actions" items={menuItems} className="topbar__narrow-only">
            <span className="topbar__more-text">More</span>
            <svg className="topbar__more-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.4" fill="currentColor" />
              <circle cx="8" cy="8" r="1.4" fill="currentColor" />
              <circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
            </svg>
          </ActionMenu>

          <span className="topbar__divider" aria-hidden="true" />

          <button
            type="button"
            className="topbar__source topbar__source--btn topbar__phone-hidden"
            onClick={() => onSwitchSource?.(live ? 'snapshot' : 'api')}
            title={live ? 'Using the live API. Switch to the demo snapshot.' : 'Using the demo snapshot. Switch to the live API.'}
          >
            <span className={live ? 'topbar__source-dot' : 'topbar__source-dot topbar__source-dot--snapshot'} />
            <span>{live ? 'Live API' : 'Demo snapshot'}</span>
          </button>

          <button
            type="button"
            className="icon-button topbar__theme"
            onClick={toggle}
            title={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
            aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
          >
            <ThemeIcon theme={theme} />
          </button>

          <button
            type="button"
            className="icon-button topbar__phone-hidden"
            onClick={onRefresh}
            disabled={refreshing}
            title={live ? 'Fetch prices again and rebuild the analytics' : 'Reload the snapshot'}
            aria-label={refreshing ? 'Refreshing' : 'Refresh'}
          >
            {refreshing ? (
              <span className="spinner spinner--on" aria-hidden="true" />
            ) : (
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
                <path d="M13.5 2.5v3.2h-3.2" />
              </svg>
            )}
          </button>
        </div>
      </div>

      <PrimaryNav view={view} analyticsReady={analyticsReady} holdingsCount={holdingsCount} />

      {/* Masthead: the portfolio's value. Full on the overview, one line elsewhere. */}
      {summary ? (
        <div
          className={
            view === 'overview' ? 'topbar__masthead' : 'topbar__masthead topbar__masthead--compact'
          }
        >
          <div className="topbar__identity">
            <div className="topbar__eyebrow">
              <span className="eyebrow">{portfolioName ?? 'Portfolio overview'}</span>
              <span className="panel__subtitle">
                {summary.holdings_count} holdings, measured against {health?.benchmark ?? 'the benchmark'}
              </span>
            </div>

            <div className="topbar__value">
              <AnimatedNumber
                value={summary.total_value}
                format={formatMoneyCompact}
                className="num topbar__amount"
              />
              <span className="topbar__currency">{baseCurrency}</span>
            </div>

            <div className="topbar__deltas">
              <Delta
                label="Today"
                absolute={summary.changes.day.absolute}
                percent={summary.changes.day.pct}
                delay={90}
              />
              <Delta
                label="Since inception"
                absolute={summary.changes.all.absolute}
                percent={summary.changes.all.pct}
                delay={150}
              />
              <Delta
                label="Unrealised P&L"
                absolute={summary.total_unrealized_pnl}
                percent={summary.total_unrealized_pnl_pct}
                delay={210}
              />
            </div>
          </div>

          <div className="topbar__aside">
            <Sparkline
              values={summary.sparkline.values}
              width={320}
              height={64}
              showEndpoint
              ariaLabel={`Portfolio value over the last ${summary.sparkline.values.length} trading days`}
            />
            <div className="topbar__meta">
              <span>
                Base <span className="topbar__meta-value num">{baseCurrency}</span>
              </span>
              <span>
                As of{' '}
                <span className="topbar__meta-value num">{formatDate(summary.as_of)}</span>
              </span>
              <span>
                Prices{' '}
                <span className="topbar__meta-value num">
                  {formatTimestamp(health?.prices_fetched_at ?? summary.generated_at)}
                </span>
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  )
}
