/**
 * Market Ticker Bar - Real-time global benchmark and market quotes banner.
 *
 * Provides continuous context of market conditions (Equities, Crypto, Rates,
 * Commodities) similar to OpenTerminal / Bloomberg headers.
 */

import { memo } from 'react'

interface MarketItem {
  symbol: string
  name: string
  price: string
  change: string
  pct: string
  isPositive: boolean
}

const DEFAULT_MARKET_ITEMS: MarketItem[] = [
  { symbol: 'S&P 500', name: 'US Large Cap', price: '5,864.67', change: '+24.50', pct: '+0.42%', isPositive: true },
  { symbol: 'NASDAQ', name: 'US Tech', price: '18,518.61', change: '+119.80', pct: '+0.65%', isPositive: true },
  { symbol: 'DOW', name: 'US Industrials', price: '42,924.88', change: '-64.20', pct: '-0.15%', isPositive: false },
  { symbol: 'BTC-USD', name: 'Bitcoin', price: '$67,420', change: '+1,410.00', pct: '+2.14%', isPositive: true },
  { symbol: 'GOLD', name: 'Gold Spot', price: '$2,721.40', change: '+10.30', pct: '+0.38%', isPositive: true },
  { symbol: 'US 10Y', name: 'Treasury Yield', price: '4.20%', change: '+0.02', pct: '+0.48%', isPositive: true },
  { symbol: 'BRENT', name: 'Crude Oil', price: '$74.29', change: '-0.61', pct: '-0.81%', isPositive: false },
]

export const MarketTickerBar = memo(function MarketTickerBar({
  items = DEFAULT_MARKET_ITEMS,
}: {
  items?: MarketItem[]
}) {
  return (
    <div className="market-ticker" aria-label="Live Market Quotes">
      <div className="market-ticker__badge">
        <span className="market-ticker__pulse" />
        <span className="market-ticker__label">MARKETS</span>
      </div>
      <div className="market-ticker__track">
        {items.map((item) => (
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
    </div>
  )
})
