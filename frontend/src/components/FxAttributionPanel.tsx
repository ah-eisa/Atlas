/**
 * Attribution of the unrealised P&L between price and currency.
 *
 * For a multi-currency book the headline profit is not one thing. A holding
 * can gain because the instrument rose, or because the currency it is quoted
 * in strengthened against the reporting currency - and the two can point in
 * opposite directions. Mixing them hides both: a book that made money on
 * prices while losing money on the currency looks identical to one that did
 * the reverse.
 *
 * The split is exact, not an estimate: the price effect is measured at the
 * exchange rate of the acquisition date, and the currency effect is the
 * remainder, so the two always add up to the reported P&L.
 */

import { useMemo } from 'react'

import { formatMoneySigned, formatPercentSigned, signClass } from '../lib/format'
import type { Holding, SummaryPayload } from '../lib/types'
import { Panel } from './Panel'

interface FxAttributionPanelProps {
  summary: SummaryPayload
  holdings: Holding[]
  currency: string
}

export function FxAttributionPanel({ summary, holdings, currency }: FxAttributionPanelProps) {
  const attribution = summary.fx_attribution

  const movers = useMemo(
    () =>
      holdings
        .filter((holding) => holding.fx_effect !== null)
        .sort((a, b) => Math.abs(b.fx_effect ?? 0) - Math.abs(a.fx_effect ?? 0))
        .slice(0, 6),
    [holdings],
  )

  const priceEffect = attribution.price_effect
  const fxEffect = attribution.fx_effect
  const total = attribution.total

  // The bar is scaled against the larger of the two absolute effects, so a
  // small currency effect next to a large price effect stays visible.
  const scale = Math.max(Math.abs(priceEffect), Math.abs(fxEffect), 1)
  const priceShare = Math.abs(priceEffect) / scale
  const fxShare = Math.abs(fxEffect) / scale

  return (
    <Panel
      title="Price vs currency"
      subtitle={`unrealised P&L attribution · ${currency}`}
    >
      <div className="attribution">
        <div className="attribution__figures">
          <div className="attribution__figure">
            <span className="attribution__label">Total unrealised</span>
            <span className={`num attribution__value ${signClass(total)}`}>
              {formatMoneySigned(total)}
            </span>
          </div>
          <div className="attribution__figure">
            <span className="attribution__label">Price effect</span>
            <span className={`num attribution__value ${signClass(priceEffect)}`}>
              {formatMoneySigned(priceEffect)}
            </span>
            <span className="attribution__context">
              what the instruments themselves did
            </span>
          </div>
          <div className="attribution__figure">
            <span className="attribution__label">Currency effect</span>
            <span className={`num attribution__value ${signClass(fxEffect)}`}>
              {formatMoneySigned(fxEffect)}
            </span>
            <span className="attribution__context">
              what the exchange rate did
            </span>
          </div>
        </div>

        <div
          className="attribution__bar"
          role="img"
          aria-label={`Price effect ${formatMoneySigned(priceEffect)}, currency effect ${formatMoneySigned(fxEffect)}`}
        >
          <span
            className={`attribution__segment attribution__segment--price ${
              priceEffect < 0 ? 'attribution__segment--negative' : ''
            }`}
            style={{ width: `${priceShare * 100}%` }}
          />
          <span
            className={`attribution__segment attribution__segment--fx ${
              fxEffect < 0 ? 'attribution__segment--negative' : ''
            }`}
            style={{ width: `${fxShare * 100}%` }}
          />
        </div>

        {movers.length > 0 ? (
          <table className="attribution__table">
            <thead>
              <tr>
                <th scope="col">Position</th>
                <th scope="col" className="tabular-right">Currency</th>
                <th scope="col" className="tabular-right">Rate now</th>
                <th scope="col" className="tabular-right">Rate at entry</th>
                <th scope="col" className="tabular-right">Currency effect</th>
              </tr>
            </thead>
            <tbody>
              {movers.map((holding) => {
                const move =
                  holding.fx_rate_at_acquisition > 0
                    ? holding.fx_rate_now / holding.fx_rate_at_acquisition - 1
                    : null
                return (
                  <tr key={holding.ticker}>
                    <td className="num attribution__ticker">{holding.ticker}</td>
                    <td className="num tabular-right">{holding.currency}</td>
                    <td className="num tabular-right">{holding.fx_rate_now.toFixed(4)}</td>
                    <td className="num tabular-right">
                      {holding.fx_rate_at_acquisition.toFixed(4)}
                    </td>
                    <td className={`num tabular-right ${signClass(holding.fx_effect)}`}>
                      {formatMoneySigned(holding.fx_effect)}
                      {move !== null ? (
                        <span className="attribution__move">
                          {' '}
                          ({formatPercentSigned(move)})
                        </span>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : null}

        <p className="attribution__note">
          The price effect is measured at the exchange rate of each position&apos;s
          acquisition date, so it reflects the instrument alone. Positions
          acquired before the price history starts cannot be attributed
          {attribution.unattributed !== 0
            ? ` (${formatMoneySigned(attribution.unattributed)} unattributed).`
            : '.'}
        </p>
      </div>
    </Panel>
  )
}
