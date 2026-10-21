/**
 * Application chrome: wordmark, primary navigation, data controls, and the
 * headline portfolio readout.
 *
 * The header is deliberately two-tier. The chrome row (brand / navigation /
 * actions) stays fixed in function across every view, while the masthead row
 * carries the portfolio identity and is allowed to disappear when there is no
 * analytics payload yet. That keeps the navigation usable in an empty state
 * instead of replacing the whole application with a spinner.
 */

import { formatDate, formatMoneyCompact, formatMoneySigned, formatPercentSigned, formatTimestamp, signClass } from '../lib/format'
import type { DataConfig } from '../lib/api'
import { useTheme } from '../lib/theme'
import type { Health, SummaryPayload } from '../lib/types'
import type { ViewKey } from '../lib/useHashRoute'
import { AnimatedNumber } from './AnimatedNumber'
import { Sparkline } from './Sparkline'

interface ViewDefinition {
  key: ViewKey
  label: string
  /** Views that need an analytics payload are disabled when none exists. */
  needsAnalytics: boolean
}

const VIEWS: ViewDefinition[] = [
  { key: 'overview', label: 'Overview', needsAnalytics: true },
  { key: 'performance', label: 'Performance', needsAnalytics: true },
  { key: 'risk', label: 'Risk', needsAnalytics: true },
  { key: 'holdings', label: 'Holdings', needsAnalytics: false },
  { key: 'projection', label: 'Projection', needsAnalytics: true },
  { key: 'data', label: 'Data', needsAnalytics: false },
]

interface TopBarProps {
  summary: SummaryPayload | null
  health: Health | null
  config: DataConfig
  view: ViewKey
  baseCurrency: string
  holdingsCount: number
  refreshing: boolean
  onRefresh: () => void
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
      <AnimatedNumber
        value={absolute}
        format={formatMoneySigned}
        delay={delay}
        className={`num ${tone}`}
      />
      <span className={`num topbar__delta-pct ${tone}`}>
        (<AnimatedNumber value={percent} format={formatPercentSigned} delay={delay} />)
      </span>
    </div>
  )
}

/**
 * Sun / moon glyph for the theme switch.
 *
 * The icon shows the theme that will be applied by pressing it, which is the
 * convention that avoids a toggle that appears to do nothing.
 */
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
}: TopBarProps) {
  const live = config.source === 'api'
  const analyticsReady = summary !== null
  const { theme, toggle } = useTheme()

  return (
    <header className={analyticsReady ? 'topbar' : 'topbar topbar--compact'}>
      <div className="topbar__chrome">
        <a className="topbar__brand" href="#/overview" aria-label="Atlas portfolio analytics home">
          <span className="topbar__wordmark">ATLAS</span>
          <span className="topbar__product">Portfolio intelligence</span>
        </a>

        <nav className="nav" aria-label="Primary">
          {VIEWS.map((item) => {
            const disabled = item.needsAnalytics && !analyticsReady
            const active = item.key === view
            if (disabled) {
              return (
                <span
                  key={item.key}
                  className="nav__link nav__link--disabled"
                  aria-disabled="true"
                  title="Add a position to unlock analytics"
                >
                  {item.label}
                </span>
              )
            }
            return (
              <a
                key={item.key}
                className={active ? 'nav__link nav__link--active' : 'nav__link'}
                href={`#/${item.key}`}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
                {item.key === 'holdings' ? (
                  <span className="nav__count num">{holdingsCount}</span>
                ) : null}
              </a>
            )
          })}
        </nav>

        <div className="topbar__actions">
          <a className="topbar__source" href="#/data" title="Data source and settings">
            <span
              className={
                live
                  ? 'topbar__source-dot'
                  : 'topbar__source-dot topbar__source-dot--snapshot'
              }
            />
            {live ? 'Live API' : 'Demo snapshot'}
          </a>
          <button
            type="button"
            className="button button--quiet topbar__theme"
            onClick={toggle}
            title={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
            aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
          >
            <ThemeIcon theme={theme} />
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={onRefresh}
            disabled={refreshing}
            title={live ? 'Refetch prices and rebuild analytics' : 'Reload the committed snapshot'}
          >
            <span className={refreshing ? 'spinner spinner--on' : 'spinner'} aria-hidden="true" />
            {refreshing ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
      </div>

      {summary ? (
        <div className="topbar__masthead">
          <div className="topbar__identity">
            <div className="topbar__eyebrow">
              <span className="eyebrow">Portfolio overview</span>
              <span className="panel__subtitle">
                {summary.holdings_count} holdings · {health?.benchmark ?? '—'} benchmark
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
              width={236}
              height={46}
              showEndpoint
              ariaLabel={`Portfolio value over the last ${summary.sparkline.values.length} trading days`}
            />
            <div className="topbar__meta">
              <span>
                Base <span className="topbar__meta-value num">{baseCurrency}</span>
              </span>
              <span>
                As of <span className="topbar__meta-value num">{formatDate(summary.as_of)}</span>
              </span>
              <span>
                Built{' '}
                <span className="topbar__meta-value num">
                  {formatTimestamp(summary.generated_at)}
                </span>
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="topbar__empty">
          <span className="eyebrow">No analytics yet</span>
          <span>
            {live
              ? 'Add a position in Holdings to build the portfolio analytics.'
              : 'This snapshot contains no usable analytics. Open the API source to create a portfolio.'}
          </span>
        </div>
      )}
    </header>
  )
}
