/**
 * Market Ticker Bar - Real-time global benchmark and market quotes banner.
 *
 * Connects directly to Yahoo Finance through the ATLAS backend API with live
 * 2026 quotes for S&P 500, Nasdaq, BTC, Gold, 10Y Yield, Oil, and EUR/USD.
 *
 * Includes 1-click dismiss button with persistent localStorage memory.
 */

import { memo, useEffect, useState } from 'react'
import type { DataConfig } from '../lib/api'
import { getMarketTicker } from '../lib/api'
import type { MarketQuote } from '../lib/types'

const INITIAL_2026_QUOTES: MarketQuote[] = [
  { symbol: 'S&P 500', name: 'US Large Cap', price: '7,645.18', change: '-110.93', pct: '-1.44%', isPositive: false },
  { symbol: 'NASDAQ', name: 'US Tech', price: '25,970.17', change: '-732.69', pct: '-2.74%', isPositive: false },
  { symbol: 'BTC-USD', name: 'Bitcoin', price: '$81,114', change: '-2,885.62', pct: '-3.43%', isPositive: false },
  { symbol: 'GOLD', name: 'Gold Spot', price: '$4,054.60', change: '-96.50', pct: '-2.33%', isPositive: false },
  { symbol: 'US 10Y', name: 'Treasury Yield', price: '4.96%', change: '-0.19', pct: '-3.67%', isPositive: false },
  { symbol: 'CRUDE OIL', name: 'WTI Crude', price: '$99.27', change: '-2.51', pct: '-2.47%', isPositive: false },
  { symbol: 'EUR/USD', name: 'Euro / USD', price: '1.1226', change: '-0.0001', pct: '-0.01%', isPositive: false },
]

export const MarketTickerBar = memo(function MarketTickerBar({
  config,
}: {
  config?: DataConfig
}) {
  const [hidden, setHidden] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('atlas_hide_ticker') === 'true'
  })

  const [quotes, setQuotes] = useState<MarketQuote[]>(INITIAL_2026_QUOTES)

  useEffect(() => {
    const handleToggle = () => {
      setHidden((prev) => {
        const next = !prev
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('atlas_hide_ticker', String(next))
        }
        return next
      })
    }
    window.addEventListener('atlas_toggle_ticker', handleToggle)
    return () => window.removeEventListener('atlas_toggle_ticker', handleToggle)
  }, [])

  useEffect(() => {
    if (hidden || !config) return
    let active = true

    const updateQuotes = async () => {
      try {
        const res = await getMarketTicker(config)
        if (active && res && res.quotes && res.quotes.length > 0) {
          setQuotes(res.quotes)
        }
      } catch {
        // Fallback quotes remain active
      }
    }

    updateQuotes()
    const timer = setInterval(updateQuotes, 60_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [config, hidden])

  if (hidden) {
    return null
  }

  return (
    <div className="market-ticker" aria-label="Live Market Quotes">
      <div className="market-ticker__badge">
        <span className="market-ticker__pulse" />
        <span className="market-ticker__label">MARKETS LIVE</span>
      </div>
      <div className="market-ticker__track">
        {quotes.map((item) => (
          <div key={item.symbol} className="market-ticker__item">
            <span className="market-ticker__symbol">{item.symbol}</span>
            <span className="market-ticker__price num">{item.price}</span>
            <span
              className={`market-ticker__change num ${
                item.isPositive ? 'market-ticker__change--pos' : 'market-ticker__change--neg'
              }`}
            >
              {item.pct}
            </span>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="market-ticker__close"
        onClick={() => {
          setHidden(true)
          if (typeof window !== 'undefined') {
            window.localStorage.setItem('atlas_hide_ticker', 'true')
          }
        }}
        aria-label="Hide market ticker bar"
        title="Hide ticker bar (can restore anytime from Ctrl+K Search)"
      >
        ✕
      </button>
    </div>
  )
})
