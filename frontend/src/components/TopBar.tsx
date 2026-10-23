/**
 * The top of the content column: the market ticker, a slim toolbar (search,
 * the actions, theme and refresh), and the portfolio's headline.
 *
 * Navigation and the portfolio switcher live in the sidebar. On the overview
 * the headline is the page's one large thing - the value in Newsreader, a
 * sentence that says what it means, and the four changes that matter beside
 * it. On every other view it shrinks to one line.
 *
 * Actions that do not fit on narrower screens move into a More menu rather
 * than disappearing.
 */

import { formatMoneyCompact, formatMoneySigned, formatPercentSigned, signClass } from '../lib/format'
import type { DataConfig } from '../lib/api'
import { useTheme } from '../lib/theme'
import type { DataSource, Health, SummaryPayload } from '../lib/types'
import type { ViewKey } from '../lib/useHashRoute'
import { ActionMenu, type ActionMenuItem } from './ActionMenu'
import { AnimatedNumber } from './AnimatedNumber'
import { MarketTickerBar } from './MarketTickerBar'

interface TopBarProps {
  summary: SummaryPayload | null
  health: Health | null
  config: DataConfig
  view: ViewKey
  baseCurrency: string
  refreshing: boolean
  onRefresh: () => void
  portfolioName?: string
  /** How many holdings stand above their cost, for the headline sentence. */
  holdingsInProfit?: number
  /** The median of next year's simulated outcomes, for the headline sentence. */
  medianNextYear?: number
  onCreatePortfolio?: () => void
  onAddPosition?: () => void
  onOpenTradeModal?: () => void
  onOpenCommandPalette?: () => void
  onOpenWatchlist?: () => void
  onOpenCsvImport?: () => void
  onSwitchSource?: (source: DataSource) => void
  onOpenMenu?: () => void
  editable?: boolean
}

interface DeltaProps {
  label: string
  absolute: number | null
  percent: number | null
  delay: number
  /** The categorical colour that keys this row. */
  mark: string
}

/** One signed change: a coloured key, the label, the figure and its percentage. */
function Delta({ label, absolute, percent, delay, mark }: DeltaProps) {
  const tone = signClass(absolute)
  return (
    <div className="topbar__delta">
      <i className="topbar__delta-mark" style={{ background: mark }} aria-hidden="true" />
      <span className="topbar__delta-label">{label}</span>
      <span className={`topbar__delta-value num ${tone}`}>
        <AnimatedNumber value={absolute} format={formatMoneySigned} delay={delay} className={`num ${tone}`} />
      </span>
      <span className="topbar__delta-pct num">
        <AnimatedNumber value={percent} format={formatPercentSigned} delay={delay} />
      </span>
    </div>
  )
}

/** Sun / moon glyph for the theme switch. */
function ThemeIcon({ theme }: { theme: 'dark' | 'light' }) {
  if (theme === 'dark') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />
    </svg>
  )
}

function longDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
}

export function TopBar({
  summary,
  health,
  config,
  view,
  baseCurrency,
  refreshing,
  onRefresh,
  portfolioName,
  holdingsInProfit,
  medianNextYear,
  onCreatePortfolio,
  onAddPosition,
  onOpenTradeModal,
  onOpenCommandPalette,
  onOpenWatchlist,
  onOpenCsvImport,
  onSwitchSource,
  onOpenMenu,
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

  const overview = view === 'overview'
  const unrealised = summary?.total_unrealized_pnl ?? null
  const unrealisedTone = signClass(unrealised)

  return (
    <header className={analyticsReady ? 'topbar' : 'topbar topbar--compact'}>
      <MarketTickerBar config={config} />

      <div className="topbar__chrome">
        {onOpenMenu ? (
          <button type="button" className="icon-button topbar__menu" onClick={onOpenMenu} aria-label="Open the menu">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        ) : null}

        {onOpenCommandPalette && (
          <button
            type="button"
            className="topbar__search"
            onClick={onOpenCommandPalette}
            aria-label="Search and commands"
            aria-keyshortcuts="Control+K"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7.5" />
              <path d="M20.5 20.5 16.5 16.5" />
            </svg>
            <span className="topbar__search-text">Search holdings, symbols or commands</span>
            <span className="topbar__search-keys" aria-hidden="true">
              <kbd className="kbd">Ctrl</kbd>
              <kbd className="kbd">K</kbd>
            </span>
          </button>
        )}

        <div className="topbar__actions">
          {onOpenCsvImport && (
            <button type="button" className="button button--sm topbar__wide-only" onClick={onOpenCsvImport}>
              Import
            </button>
          )}

          {onOpenWatchlist && (
            <button type="button" className="button button--sm topbar__wide-only" onClick={onOpenWatchlist}>
              Watchlist
            </button>
          )}

          {editable && onAddPosition && (
            <button type="button" className="button button--sm topbar__wide-only" onClick={onAddPosition}>
              Add position
            </button>
          )}

          {editable && onOpenTradeModal && (
            <button type="button" className="button button--primary button--sm" onClick={onOpenTradeModal}>
              Trade
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

      {summary ? (
        <div className={overview ? 'topbar__masthead' : 'topbar__masthead topbar__masthead--compact'}>
          <div className="topbar__identity">
            <div className="topbar__eyebrow">
              <span className="eyebrow">{overview ? longDate(summary.as_of) : portfolioName ?? 'Portfolio'}</span>
              <span className={`topbar__chip num ${signClass(summary.changes.day.pct)}`}>
                {formatPercentSigned(summary.changes.day.pct)} today
              </span>
            </div>

            <div className="topbar__value">
              <AnimatedNumber value={summary.total_value} format={formatMoneyCompact} className="num topbar__amount" />
              <span className="topbar__currency">{baseCurrency}</span>
            </div>

            {overview ? (
              <p className="topbar__story">
                Against what you paid, {portfolioName ? `the ${portfolioName} portfolio` : 'the portfolio'} is{' '}
                <b className={`num ${unrealisedTone}`}>
                  {formatMoneySigned(unrealised)} {baseCurrency}
                </b>{' '}
                ({formatPercentSigned(summary.total_unrealized_pnl_pct)}).
                {holdingsInProfit !== undefined
                  ? ` ${holdingsInProfit} of your ${summary.holdings_count} holdings are in profit`
                  : ''}
                {medianNextYear !== undefined ? (
                  <>
                    {holdingsInProfit !== undefined ? ', and the' : ' The'} middle of next year's simulated outcomes is{' '}
                    <b className="num">
                      {formatMoneyCompact(medianNextYear)} {baseCurrency}
                    </b>
                    .
                  </>
                ) : holdingsInProfit !== undefined ? (
                  '.'
                ) : null}{' '}
                It is measured against {health?.benchmark ?? 'its benchmark'}.
              </p>
            ) : null}
          </div>

          <div className="topbar__deltas">
            <Delta label="Today" absolute={summary.changes.day.absolute} percent={summary.changes.day.pct} delay={90} mark="var(--viz-cat-1)" />
            <Delta label="This year" absolute={summary.changes.ytd.absolute} percent={summary.changes.ytd.pct} delay={150} mark="var(--viz-cat-4)" />
            <Delta label="Since the start" absolute={summary.changes.all.absolute} percent={summary.changes.all.pct} delay={210} mark="var(--viz-cat-6)" />
            <Delta label="Unrealised" absolute={summary.total_unrealized_pnl} percent={summary.total_unrealized_pnl_pct} delay={270} mark="var(--viz-cat-3)" />
          </div>
        </div>
      ) : null}
    </header>
  )
}
