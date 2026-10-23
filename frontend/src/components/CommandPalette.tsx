import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useModalBehaviour } from '../lib/useModalBehaviour'
import { type DataConfig, downloadExport } from '../lib/api'
import { dispatchCommandIntent } from '../lib/commandBus'
import { formatMoney, formatPercent } from '../lib/format'
import { useTheme } from '../lib/theme'
import type { DataSource, OrderType, PortfolioState } from '../lib/types'
import type { ViewKey } from '../lib/useHashRoute'

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  state: PortfolioState | null
  config: DataConfig
  onNavigate: (view: ViewKey) => void
  onOpenTradeModal?: (ticker?: string, type?: OrderType) => void
  onAddPosition?: () => void
  onOpenCsvImport?: () => void
  onOpenWatchlist?: () => void
  onCreatePortfolio?: () => void
  onSelectPortfolio?: (id: number) => void
  onSwitchSource?: (source: DataSource) => void
  onRefresh?: () => void
}

interface CommandItem {
  id: string
  category: 'Ticker Actions' | 'Holdings' | 'Lab & Stress' | 'Macro & Rates' | 'Navigation' | 'Actions'
  title: string
  subtitle: string
  badge?: string
  keywords: string
  action: () => void
}

const KNOWN_TICKERS = new Set([
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'GOOGL',
  'GOOG',
  'META',
  'TSLA',
  'AMD',
  'NFLX',
  'JPM',
  'V',
  'MA',
  'AVGO',
  'SPY',
  'QQQ',
  'LLY',
  'XOM',
  'UNH',
  'JNJ',
  'WMT',
  'PG',
])

export function CommandPalette({
  isOpen,
  onClose,
  state,
  config,
  onNavigate,
  onOpenTradeModal,
  onAddPosition,
  onOpenCsvImport,
  onOpenWatchlist,
  onCreatePortfolio,
  onSelectPortfolio,
  onSwitchSource,
  onRefresh,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const { theme, toggle: toggleTheme } = useTheme()

  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
    }
  }, [isOpen])

  const items = useMemo<CommandItem[]>(() => {
    const list: CommandItem[] = []
    const q = query.trim()
    const tokens = q.toUpperCase().split(/\s+/).filter(Boolean)
    const firstToken = tokens[0] ?? ''

    const heldTickers = new Set(
      (state?.positions ?? []).map((p) => p.ticker.toUpperCase()),
    )
    const isTickerCandidate =
      firstToken.length >= 1 &&
      firstToken.length <= 6 &&
      /^[A-Z]{1,5}([.-][A-Z]{1,3})?$/.test(firstToken) &&
      (KNOWN_TICKERS.has(firstToken) ||
        heldTickers.has(firstToken) ||
        tokens.some((t) =>
          ['10-K', '10K', '10-Q', '10Q', '8-K', 'SEC', 'FILING', 'OPTIONS', 'CHAIN', 'GREEKS', 'BUY', 'SELL'].includes(
            t,
          ),
        ) ||
        (tokens.length === 1 && firstToken.length >= 2 && firstToken.length <= 5))

    if (isTickerCandidate) {
      const formHint: 'ALL' | '10-K' | '10-Q' | '8-K' = tokens.some((t) => t === '10-K' || t === '10K')
        ? '10-K'
        : tokens.some((t) => t === '10-Q' || t === '10Q')
          ? '10-Q'
          : tokens.some((t) => t === '8-K' || t === '8K')
            ? '8-K'
            : 'ALL'

      list.push({
        id: `sec-${firstToken}-${formHint}`,
        category: 'Ticker Actions',
        title: `${firstToken} — SEC EDGAR Filings (${formHint === 'ALL' ? '10-K, 10-Q, 8-K' : formHint})`,
        subtitle: `Open regulatory filings for ${firstToken} in Macro & SEC workspace`,
        badge: 'SEC EDGAR',
        keywords: `${firstToken} sec edgar 10-k 10k 10-q 10q 8-k filings annual quarterly report`,
        action: () => {
          dispatchCommandIntent({
            view: 'macro',
            tab: 'sec',
            ticker: firstToken,
            form: formHint,
          })
          onClose()
        },
      })

      list.push({
        id: `opt-${firstToken}`,
        category: 'Ticker Actions',
        title: `${firstToken} — Options Chain & Implied Volatility`,
        subtitle: `Inspect calls, puts, strikes, and Black-Scholes Greeks for ${firstToken}`,
        badge: 'OPTIONS',
        keywords: `${firstToken} options chain calls puts greeks delta gamma vega theta iv`,
        action: () => {
          dispatchCommandIntent({
            view: 'options',
            tab: 'chain',
            ticker: firstToken,
          })
          onClose()
        },
      })

      if (state?.editable && onOpenTradeModal) {
        list.push({
          id: `buy-${firstToken}`,
          category: 'Ticker Actions',
          title: `Buy ${firstToken} — Execute Order`,
          subtitle: `Open trade ticket pre-filled for ${firstToken}`,
          badge: 'BUY',
          keywords: `${firstToken} buy trade order execute`,
          action: () => {
            onClose()
            onOpenTradeModal(firstToken, 'BUY')
          },
        })
      }
    }

    // Portfolio Holdings
    const pricedHoldings = state?.analytics?.holdings.holdings ?? []
    for (const h of pricedHoldings) {
      list.push({
        id: `holding-${h.ticker}`,
        category: 'Holdings',
        title: `${h.ticker} · ${h.name}`,
        subtitle: `${h.asset_class} · Weight ${formatPercent(h.allocation_pct)} · Value ${formatMoney(h.value_base)} ${state?.baseCurrency ?? 'USD'}`,
        badge: formatPercent(h.allocation_pct),
        keywords: `${h.ticker} ${h.name} ${h.asset_class} ${h.region ?? ''} ${h.currency} holding position`,
        action: () => {
          onNavigate('holdings')
          onClose()
        },
      })
    }

    // Lab & Stress Scenarios
    list.push(
      {
        id: 'lab-xray',
        category: 'Lab & Stress',
        title: 'Portfolio X-Ray Diagnostics',
        subtitle: 'Concentration (HHI), risk hogs, multi-dimensional exposure, and correlation overlap',
        badge: 'X-RAY',
        keywords: 'xray x-ray concentration hhi overlap correlation risk hogs diagnostics lab',
        action: () => {
          dispatchCommandIntent({ view: 'xray', tab: 'xray' })
          onClose()
        },
      },
      {
        id: 'lab-stress-builder',
        category: 'Lab & Stress',
        title: 'Stress Lab & Custom Scenario Builder',
        subtitle: 'Simulate simultaneous equity, interest rate, USD, gold, and crypto shocks',
        badge: 'STRESS',
        keywords: 'stress test lab scenario builder shock equity rates usd gold crypto',
        action: () => {
          dispatchCommandIntent({ view: 'xray', tab: 'stress' })
          onClose()
        },
      },
      {
        id: 'lab-stress-2008',
        category: 'Lab & Stress',
        title: 'Stress Scenario: 2008 Financial Crisis (GFC)',
        subtitle: 'Equities -50%, Rates -200 bps, USD +12%, Gold +10%',
        badge: '2008 GFC',
        keywords: '2008 gfc financial crisis crash stress scenario',
        action: () => {
          dispatchCommandIntent({ view: 'xray', tab: 'stress', scenarioKey: 'gfc_2008' })
          onClose()
        },
      },
      {
        id: 'lab-stress-covid',
        category: 'Lab & Stress',
        title: 'Stress Scenario: 2020 COVID-19 Crash',
        subtitle: 'Equities -34%, Rates -120 bps, USD +6%, Crypto -50%',
        badge: 'COVID-19',
        keywords: '2020 covid pandemic crash stress scenario',
        action: () => {
          dispatchCommandIntent({ view: 'xray', tab: 'stress', scenarioKey: 'covid_2020' })
          onClose()
        },
      },
      {
        id: 'lab-stress-2022',
        category: 'Lab & Stress',
        title: 'Stress Scenario: 2022 Rate Hike Shock',
        subtitle: 'Equities -25%, Rates +250 bps, USD +12%, Bonds & Stocks down together',
        badge: '2022 RATES',
        keywords: '2022 rate shock inflation hike stress scenario',
        action: () => {
          dispatchCommandIntent({ view: 'xray', tab: 'stress', scenarioKey: 'rates_2022' })
          onClose()
        },
      },
      {
        id: 'lab-attribution',
        category: 'Lab & Stress',
        title: 'Brinson-Fachler Performance Attribution',
        subtitle: 'Decompose active return into Allocation, Selection, and Interaction effects',
        badge: 'ATTRIBUTION',
        keywords: 'attribution brinson fachler allocation selection interaction active return benchmark',
        action: () => {
          dispatchCommandIntent({ view: 'xray', tab: 'attribution' })
          onClose()
        },
      },
      {
        id: 'lab-factsheet-report',
        category: 'Lab & Stress',
        title: 'Investment Factsheet & IC Memo Generator',
        subtitle: 'One-page institutional portfolio factsheet, executive commentary, Markdown memo, and print/PDF',
        badge: 'FACTSHEET',
        keywords: 'factsheet report ic memo investment committee pdf print markdown summary',
        action: () => {
          dispatchCommandIntent({ view: 'xray', tab: 'report' })
          onClose()
        },
      },
    )

    // Macro & Fixed Income Series
    list.push(
      {
        id: 'rates-10y-curve',
        category: 'Macro & Rates',
        title: 'US Treasury Yield Curve (1M – 30Y) & 10Y-2Y Spread',
        subtitle: 'Live Treasury term structure, 1M/1Y comparison, and Moody’s Aaa/Baa credit spreads',
        badge: '10Y CURVE',
        keywords: '10y curve yield treasury bonds fixed income 2y 30y inversion spread',
        action: () => {
          onNavigate('bonds')
          onClose()
        },
      },
      {
        id: 'macro-cpi',
        category: 'Macro & Rates',
        title: 'US Headline CPI Inflation (CPIAUCSL)',
        subtitle: 'FRED macroeconomic inflation time-series and YoY trend',
        badge: 'FRED CPI',
        keywords: 'cpi inflation macro fred price index cpiaucsl',
        action: () => {
          dispatchCommandIntent({ view: 'macro', tab: 'macro', series: 'CPIAUCSL' })
          onClose()
        },
      },
      {
        id: 'macro-fed-funds',
        category: 'Macro & Rates',
        title: 'Federal Funds Effective Rate (DFF)',
        subtitle: 'Federal Reserve monetary policy benchmark interest rate',
        badge: 'FED RATE',
        keywords: 'fed funds rate dff interest monetary policy fomc macro',
        action: () => {
          dispatchCommandIntent({ view: 'macro', tab: 'macro', series: 'DFF' })
          onClose()
        },
      },
      {
        id: 'macro-gdp',
        category: 'Macro & Rates',
        title: 'Real GDP Growth & Unemployment (GDPC1 / UNRATE)',
        subtitle: 'US macroeconomic growth and labor market indicators',
        badge: 'GDP',
        keywords: 'gdp growth unemployment unrate gdpc1 macro economy',
        action: () => {
          dispatchCommandIntent({ view: 'macro', tab: 'macro', series: 'GDPC1' })
          onClose()
        },
      },
    )

    // Primary Views
    const navItems: { key: ViewKey; title: string; subtitle: string; keywords: string }[] = [
      {
        key: 'overview',
        title: 'Go to Overview',
        subtitle: 'Executive KPI strip, NAV history, allocation, and return vs risk',
        keywords: 'overview home dashboard summary nav kpi',
      },
      {
        key: 'performance',
        title: 'Go to Performance',
        subtitle: 'Cumulative return, benchmark comparison, rolling Sharpe, and monthly heatmap',
        keywords: 'performance returns twr mwr xirr benchmark sharpe',
      },
      {
        key: 'risk',
        title: 'Go to Portfolio Risk',
        subtitle: 'VaR, CVaR, drawdown, correlation matrix, risk contributions, and what-if rebalancer',
        keywords: 'portfolio risk var cvar drawdown volatility beta correlation what-if',
      },
      {
        key: 'holdings',
        title: 'Go to Holdings & Cash Flows',
        subtitle: 'Manage positions, cost basis, target weights, and external cash flows',
        keywords: 'holdings positions weights cash flows',
      },
      {
        key: 'trades',
        title: 'Go to Trades & Realized P&L Ledger',
        subtitle: 'FIFO lot-matching execution ledger, win rate, and realized P&L',
        keywords: 'trades transactions ledger fifo realized pnl buy sell orders',
      },
      {
        key: 'bonds',
        title: 'Go to Fixed Income & Bond Calculator',
        subtitle: 'Treasury yield curves, credit spreads, Macaulay/Modified duration, convexity, and DV01',
        keywords: 'fixed income bonds duration convexity dv01 ytm yield calculator',
      },
      {
        key: 'macro',
        title: 'Go to Macro & SEC Filings',
        subtitle: 'FRED macroeconomic indicators and live SEC EDGAR 10-K/10-Q/8-K filings',
        keywords: 'macro sec edgar filings 10-k 10-q 8-k fred',
      },
      {
        key: 'options',
        title: 'Go to Options & Black-Scholes Greeks',
        subtitle: 'Options chain matrix and Black-Scholes pricing / Greeks calculator',
        keywords: 'options greeks black scholes delta gamma vega theta payoff',
      },
      {
        key: 'projection',
        title: 'Go to Monte Carlo Projection',
        subtitle: 'Correlated geometric Brownian motion fan chart and terminal wealth distribution',
        keywords: 'projection monte carlo simulation forecast fan chart',
      },
      {
        key: 'data',
        title: 'Go to Data Provenance & Export',
        subtitle: 'Data quality audit, portfolio switcher, and JSON/CSV export',
        keywords: 'data provenance quality export json csv settings',
      },
    ]

    for (const nav of navItems) {
      list.push({
        id: `nav-${nav.key}`,
        category: 'Navigation',
        title: nav.title,
        subtitle: nav.subtitle,
        badge: `#/${nav.key}`,
        keywords: nav.keywords,
        action: () => {
          onNavigate(nav.key)
          onClose()
        },
      })
    }

    // Quick Terminal Actions
    if (state?.editable && onOpenTradeModal) {
      list.push({
        id: 'act-trade',
        category: 'Actions',
        title: 'Execute Trade Order (Buy / Sell)',
        subtitle: 'Record a new buy or sell execution with FIFO realized P&L',
        badge: 'ACTION',
        keywords: 'execute trade buy sell order ticket',
        action: () => {
          onClose()
          onOpenTradeModal()
        },
      })
    }

    if (state?.editable && onAddPosition) {
      list.push({
        id: 'act-add-pos',
        category: 'Actions',
        title: 'Add New Position to Portfolio',
        subtitle: 'Open position editor with Yahoo Finance ticker lookup',
        badge: 'ACTION',
        keywords: 'add new position holding instrument',
        action: () => {
          onClose()
          onAddPosition()
        },
      })
    }

    if (onOpenWatchlist) {
      list.push({
        id: 'act-watchlist',
        category: 'Actions',
        title: 'Open Watchlists & Smart Alerts',
        subtitle: 'Target buy/sell price alerts, macro guardrails, and risk thresholds',
        badge: 'WATCHLIST',
        keywords: 'watchlist alerts targets buy sell prices guardrails',
        action: () => {
          onClose()
          onOpenWatchlist()
        },
      })
    }

    if (onOpenCsvImport) {
      list.push({
        id: 'act-csv-import',
        category: 'Actions',
        title: 'Broker Statement & CSV Import Wizard',
        subtitle: 'Import holdings, trades, and cash flows from CSV or IBKR statements',
        badge: 'IMPORT',
        keywords: 'import csv broker statement ibkr positions trades',
        action: () => {
          onClose()
          onOpenCsvImport()
        },
      })
    }

    list.push({
      id: 'act-toggle-ticker',
      category: 'Actions',
      title: 'Toggle Market Ticker Bar (Show / Hide)',
      subtitle: 'Show or hide the real-time global market ticker banner at the top of the screen',
      badge: 'VIEW',
      keywords: 'ticker market quotes banner hide show toggle',
      action: () => {
        onClose()
        window.dispatchEvent(new CustomEvent('atlas_toggle_ticker'))
      },
    })

    if (config.source === 'api' && onCreatePortfolio) {
      list.push({
        id: 'act-new-portfolio',
        category: 'Actions',
        title: 'Create New Portfolio Book',
        subtitle: 'Add a separate portfolio with its own base currency',
        badge: 'BOOK',
        keywords: 'create new portfolio book currency',
        action: () => {
          onClose()
          onCreatePortfolio()
        },
      })
    }

    if (config.source === 'api' && state?.portfolios && onSelectPortfolio) {
      for (const p of state.portfolios) {
        if (p.id !== state.portfolioId) {
          list.push({
            id: `switch-book-${p.id}`,
            category: 'Actions',
            title: `Switch Portfolio Book → ${p.name} (${p.base_currency})`,
            subtitle: `Load positions and analytics for ${p.name}`,
            badge: p.base_currency,
            keywords: `switch portfolio book ${p.name} ${p.base_currency}`,
            action: () => {
              onClose()
              onSelectPortfolio(p.id)
            },
          })
        }
      }
    }

    list.push(
      {
        id: 'act-theme',
        category: 'Actions',
        title: `Switch Theme to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`,
        subtitle: 'Toggle terminal appearance between Carbon Dark and Light palettes',
        badge: 'THEME',
        keywords: 'theme dark light mode appearance toggle',
        action: () => {
          toggleTheme()
          onClose()
        },
      },
      {
        id: 'act-source',
        category: 'Actions',
        title: `Switch Data Source to ${config.source === 'api' ? 'Demo Snapshot' : 'Live API'}`,
        subtitle: 'Toggle between live FastAPI backend and committed snapshot',
        badge: 'SOURCE',
        keywords: 'switch data source live api demo snapshot',
        action: () => {
          onClose()
          onSwitchSource?.(config.source === 'api' ? 'snapshot' : 'api')
        },
      },
      {
        id: 'act-refresh',
        category: 'Actions',
        title: 'Refresh Market Prices & Rebuild Analytics',
        subtitle: 'Fetch latest quotes and recompute risk, attribution, and NAV',
        badge: 'REFRESH',
        keywords: 'refresh reload market prices analytics',
        action: () => {
          onClose()
          onRefresh?.()
        },
      },
      {
        id: 'act-export-csv',
        category: 'Actions',
        title: 'Export Portfolio to CSV',
        subtitle: 'Download positions and cash flows as a spreadsheet-ready CSV',
        badge: 'EXPORT',
        keywords: 'export download csv spreadsheet portfolio',
        action: () => {
          onClose()
          void downloadExport(config, 'csv')
        },
      },
    )

    if (!q) {
      return list
    }

    const lowerTerms = q.toLowerCase().split(/\s+/).filter(Boolean)
    return list.filter((item) => {
      const haystack = `${item.title} ${item.subtitle} ${item.keywords} ${item.category}`.toLowerCase()
      return lowerTerms.every((term) => haystack.includes(term))
    })
  }, [
    query,
    state,
    config,
    theme,
    toggleTheme,
    onNavigate,
    onClose,
    onOpenTradeModal,
    onAddPosition,
    onCreatePortfolio,
    onSelectPortfolio,
    onSwitchSource,
    onRefresh,
  ])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Keep the highlighted option in view while moving with the arrow keys.
  useEffect(() => {
    if (!isOpen) return
    document
      .getElementById(`palette-option-${selectedIndex}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [isOpen, selectedIndex])

  useModalBehaviour(isOpen, panelRef, onClose, inputRef)

  if (!isOpen) return null

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => (items.length > 0 ? (prev + 1) % items.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) =>
        items.length > 0 ? (prev - 1 + items.length) % items.length : 0,
      )
    } else if (e.key === 'Enter' && items[selectedIndex]) {
      e.preventDefault()
      items[selectedIndex].action()
    }
  }

  return createPortal(
    <div
      className="dialog-backdrop palette-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="palette__search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7.5" />
            <path d="M20.5 20.5 16.5 16.5" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="palette__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search holdings, symbols and views, or type a command"
            aria-label="Search holdings, symbols and commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-listbox"
            aria-activedescendant={items[selectedIndex] ? `palette-option-${selectedIndex}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="kbd">Esc</kbd>
        </div>

        <div className="palette__results" id="palette-listbox" role="listbox" aria-label="Results">
          {items.length === 0 ? (
            <p className="palette__empty">
              Nothing matches “{query}”. Try a symbol such as AAPL, or a view such as risk.
            </p>
          ) : (
            items.map((item, idx) => {
              const active = idx === selectedIndex
              const prevCategory = idx > 0 ? items[idx - 1].category : null
              const showCategory = item.category !== prevCategory

              return (
                <div key={item.id} role="presentation">
                  {showCategory && (
                    <div className="palette__group" role="presentation">
                      {item.category}
                    </div>
                  )}
                  <div
                    id={`palette-option-${idx}`}
                    role="option"
                    aria-selected={active}
                    className={active ? 'palette__option palette__option--active' : 'palette__option'}
                    onMouseMove={() => {
                      if (!active) setSelectedIndex(idx)
                    }}
                    onClick={() => item.action()}
                  >
                    <div className="palette__option-text">
                      <span className="palette__option-title">{item.title}</span>
                      <span className="palette__option-subtitle">{item.subtitle}</span>
                    </div>
                    {item.badge && <span className="palette__badge num">{item.badge}</span>}
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="palette__footer" aria-hidden="true">
          <span>
            <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> to move
          </span>
          <span>
            <kbd className="kbd">Enter</kbd> to open
          </span>
          <span className="palette__footer-end">
            <kbd className="kbd">[</kbd> <kbd className="kbd">]</kbd> previous or next view
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
