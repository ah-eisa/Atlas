/**
 * The top of the content column: the market ticker, a pinned glass toolbar
 * (search, theme, reporting currency and the actions), and the portfolio's
 * headline.
 *
 * Navigation and the portfolio switcher live in the sidebar. On the overview
 * the headline is the page's one large thing: a statement card with the
 * value, a sentence that says what it means and the four figures behind it,
 * beside four cards for the changes that matter. On every other view it
 * shrinks to one line.
 *
 * Actions that do not fit on narrower screens move into a More menu rather
 * than disappearing.
 */

import { useState } from 'react'

import type { DataConfig } from '../lib/api'
import { COMMON_CURRENCIES } from '../lib/currencies'
import { formatMoney, formatMoneyCompact, formatMoneySigned, formatPercentSigned, signClass } from '../lib/format'
import { useTheme } from '../lib/theme'
import type { DataSource, Health, PeriodChange, SummaryPayload } from '../lib/types'
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
  /** Restates the portfolio in another currency; absent when it cannot be changed. */
  onChangeCurrency?: (currency: string) => Promise<void>
  editable?: boolean
}

interface DeltaProps {
  label: string
  absolute: number | null
  percent: number | null
  delay: number
  /** The categorical colour that keys this change. */
  mark: string
}

/** One signed change on one line, for the compact headline. */
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

interface KpiCardProps extends DeltaProps {
  /** What the change is net of, or what it is measured against. */
  note: string
}

/** One change as a card: key, label and percentage, the figure, and its context. */
function KpiCard({ label, absolute, percent, delay, mark, note }: KpiCardProps) {
  const tone = signClass(absolute)
  return (
    <div className="kpi-card" style={{ animationDelay: `${delay}ms` }}>
      <div className="kpi-card__head">
        <span className="kpi-card__label">
          <i className="kpi-card__mark" style={{ background: mark }} aria-hidden="true" />
          {label}
        </span>
        <span className={`kpi-card__pct num ${tone}`}>{formatPercentSigned(percent)}</span>
      </div>
      <span className={`kpi-card__value num ${tone}`}>
        <AnimatedNumber value={absolute} format={formatMoneySigned} delay={delay} className={`num ${tone}`} />
      </span>
      <span className="kpi-card__note num">{note}</span>
    </div>
  )
}

/** What a period's change is net of: the money added or withdrawn during it. */
function flowNote(change: PeriodChange, currency: string): string {
  if (!change.flows) return 'No deposits or withdrawals'
  const direction = change.flows > 0 ? 'Net of deposits' : 'Net of withdrawals'
  return `${direction} of ${formatMoneyCompact(Math.abs(change.flows))} ${currency}`
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
    </svg>
  )
}

function longDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
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
  onChangeCurrency,
  editable = false,
}: TopBarProps) {
  const live = config.source === 'api'
  const { theme, setTheme } = useTheme()
  const [currencyBusy, setCurrencyBusy] = useState(false)
  const [currencyError, setCurrencyError] = useState<string | null>(null)

  const changeCurrency = async (code: string) => {
    if (!onChangeCurrency || code === baseCurrency) return
    setCurrencyBusy(true)
    setCurrencyError(null)
    try {
      await onChangeCurrency(code)
    } catch (cause) {
      setCurrencyError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCurrencyBusy(false)
    }
  }

  // A portfolio may report in a currency outside the common list; it stays
  // selectable so the control always shows the truth.
  const currencies = COMMON_CURRENCIES.some((currency) => currency.code === baseCurrency)
    ? COMMON_CURRENCIES
    : [{ code: baseCurrency, name: baseCurrency }, ...COMMON_CURRENCIES]

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
  const holdingsCount = summary?.holdings_count ?? 0

  return (
    <>
      <div className="topbar">
        <MarketTickerBar config={config} />
      </div>

      <div className="topbar__chrome">
        <div className="topbar__chrome-inner">
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
            <div className="theme-switch topbar__phone-hidden" role="group" aria-label="Theme">
              <button type="button" className="theme-switch__option" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>
                <SunIcon />
                Light
              </button>
              <button type="button" className="theme-switch__option" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>
                <MoonIcon />
                Dark
              </button>
            </div>

            {onChangeCurrency ? (
              <label
                className={currencyError ? 'currency-switch currency-switch--error' : 'currency-switch'}
                title={currencyError ? `Could not change the currency: ${currencyError}` : 'The currency every figure is reported in'}
              >
                <span className="sr-only">Reporting currency</span>
                <select
                  className="currency-switch__select num"
                  value={baseCurrency}
                  disabled={currencyBusy || refreshing}
                  onChange={(event) => void changeCurrency(event.target.value)}
                >
                  {currencies.map((currency) => (
                    <option key={currency.code} value={currency.code}>
                      {currency.code}
                    </option>
                  ))}
                </select>
                {currencyBusy ? <span className="spinner spinner--on" aria-hidden="true" /> : null}
              </label>
            ) : null}

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
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
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
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
              aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
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
      </div>

      {summary && overview ? (
        <header className="topbar">
          <div className="topbar__masthead">
            <section className="statement" aria-label="Portfolio value">
              <div className="statement__glow" aria-hidden="true" />
              <div className="topbar__eyebrow">
                <span className="eyebrow eyebrow--caps">Net liquidating value</span>
                <span className="eyebrow__sep" aria-hidden="true">
                  •
                </span>
                <span className="eyebrow">{longDate(summary.as_of)}</span>
                <span className={`topbar__chip num ${signClass(summary.changes.day.pct)}`}>
                  {formatPercentSigned(summary.changes.day.pct)} today
                </span>
              </div>

              <div className="topbar__value">
                <AnimatedNumber value={summary.total_value} format={formatMoney} className="num topbar__amount" />
                <span className="topbar__currency">{baseCurrency}</span>
              </div>

              <p className="topbar__story">
                Against what you paid, {portfolioName ? `the ${portfolioName} portfolio` : 'the portfolio'} is{' '}
                <b className={`num ${unrealisedTone}`}>
                  {formatMoneySigned(unrealised)} {baseCurrency}
                </b>{' '}
                ({formatPercentSigned(summary.total_unrealized_pnl_pct)}).
                {holdingsInProfit !== undefined ? ` ${holdingsInProfit} of your ${holdingsCount} holdings are in profit` : ''}
                {medianNextYear !== undefined ? (
                  <>
                    {holdingsInProfit !== undefined ? ', and the' : ' The'} middle of next year's simulated outcomes is{' '}
                    <b className="num gold">
                      {formatMoneyCompact(medianNextYear)} {baseCurrency}
                    </b>
                    .
                  </>
                ) : holdingsInProfit !== undefined ? (
                  '.'
                ) : null}{' '}
                It is measured against {health?.benchmark ?? 'its benchmark'}.
              </p>

              <dl className="statement__facts">
                <div>
                  <dt>Invested capital</dt>
                  <dd className="num">{formatMoney(summary.total_cost)}</dd>
                </div>
                <div>
                  <dt>Unrealised P&amp;L</dt>
                  <dd className={`num ${unrealisedTone}`}>{formatMoneySigned(unrealised)}</dd>
                </div>
                {holdingsInProfit !== undefined && holdingsCount > 0 ? (
                  <div>
                    <dt>Profitable positions</dt>
                    <dd className="num pos">
                      {holdingsInProfit} / {holdingsCount} ({Math.round((holdingsInProfit / holdingsCount) * 100)}%)
                    </dd>
                  </div>
                ) : null}
                {medianNextYear !== undefined ? (
                  <div>
                    <dt>1Y projection median</dt>
                    <dd className="num gold">{formatMoneyCompact(medianNextYear)}</dd>
                  </div>
                ) : null}
              </dl>
            </section>

            <div className="topbar__kpis">
              <KpiCard
                label="Today"
                absolute={summary.changes.day.absolute}
                percent={summary.changes.day.pct}
                delay={90}
                mark="var(--viz-cat-1)"
                note={flowNote(summary.changes.day, baseCurrency)}
              />
              <KpiCard
                label="This year"
                absolute={summary.changes.ytd.absolute}
                percent={summary.changes.ytd.pct}
                delay={150}
                mark="var(--viz-cat-2)"
                note={flowNote(summary.changes.ytd, baseCurrency)}
              />
              <KpiCard
                label="Since the start"
                absolute={summary.changes.all.absolute}
                percent={summary.changes.all.pct}
                delay={210}
                mark="var(--viz-cat-6)"
                note={flowNote(summary.changes.all, baseCurrency)}
              />
              <KpiCard
                label="Unrealised"
                absolute={summary.total_unrealized_pnl}
                percent={summary.total_unrealized_pnl_pct}
                delay={270}
                mark="var(--accent)"
                note={`Against a cost of ${formatMoneyCompact(summary.total_cost)} ${baseCurrency}`}
              />
            </div>
          </div>
        </header>
      ) : summary ? (
        <header className="topbar">
          <div className="topbar__masthead topbar__masthead--compact">
            <div className="topbar__identity">
              <div className="topbar__eyebrow">
                <span className="eyebrow">{portfolioName ?? 'Portfolio'}</span>
                <span className={`topbar__chip num ${signClass(summary.changes.day.pct)}`}>
                  {formatPercentSigned(summary.changes.day.pct)} today
                </span>
              </div>

              <div className="topbar__value">
                <AnimatedNumber value={summary.total_value} format={formatMoneyCompact} className="num topbar__amount" />
                <span className="topbar__currency">{baseCurrency}</span>
              </div>
            </div>

            <div className="topbar__deltas">
              <Delta label="Today" absolute={summary.changes.day.absolute} percent={summary.changes.day.pct} delay={90} mark="var(--viz-cat-1)" />
              <Delta
                label="Unrealised"
                absolute={summary.total_unrealized_pnl}
                percent={summary.total_unrealized_pnl_pct}
                delay={150}
                mark="var(--accent)"
              />
            </div>
          </div>
        </header>
      ) : null}
    </>
  )
}
