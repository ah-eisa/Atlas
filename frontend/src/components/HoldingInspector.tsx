/**
 * One holding up close: what it is worth, what it has earned, how its price
 * has moved over the last ninety sessions (in the reporting currency), and a
 * what-if slider that shows the weight it would carry at another size.
 *
 * The slider changes nothing. It answers "what if I bought or trimmed this
 * much?" in place; the Trade button is where an order is actually placed.
 */

import { useEffect, useState } from 'react'

import { assetClassColor } from '../lib/assetColors'
import {
  formatDate,
  formatMoney,
  formatMoneyCompact,
  formatMoneySigned,
  formatPercent,
  formatPercentSigned,
  formatPrice,
  formatQuantity,
  signClass,
} from '../lib/format'
import type { Holding } from '../lib/types'
import { Dialog } from './Dialog'
import { Sparkline } from './Sparkline'

interface HoldingInspectorProps {
  holding: Holding | null
  totalValue: number
  currency: string
  onClose: () => void
  onTrade?: (ticker: string) => void
  onEdit?: (holding: Holding) => void
}

/** The slider runs from nothing to twice the position, or a sensible floor. */
function sliderMax(value: number, totalValue: number): number {
  const ceiling = Math.max(value * 2, totalValue * 0.25, 1)
  const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(ceiling)) - 1)
  return Math.ceil(ceiling / magnitude) * magnitude
}

export function HoldingInspector({ holding, totalValue, currency, onClose, onTrade, onEdit }: HoldingInspectorProps) {
  const [simulated, setSimulated] = useState(0)

  useEffect(() => {
    if (holding) setSimulated(holding.value_base)
  }, [holding])

  if (!holding) return null

  const color = assetClassColor(holding.asset_class)
  const prices = holding.sparkline.filter((price) => Number.isFinite(price))
  const low = prices.length ? Math.min(...prices) : null
  const high = prices.length ? Math.max(...prices) : null
  const last = prices.length ? prices[prices.length - 1] : null
  const trend = prices.length > 1 ? prices[prices.length - 1] / prices[0] - 1 : null

  const max = sliderMax(holding.value_base, totalValue)
  const step = max / 200
  const delta = simulated - holding.value_base
  const newTotal = totalValue + delta
  const newWeight = newTotal > 0 ? simulated / newTotal : 0
  const unchanged = Math.abs(delta) < step / 2

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      closeOnBackdrop
      className="inspector"
      title={
        <span className="inspector__title">
          <span className="grid__mark inspector__mark" style={{ background: color }} aria-hidden="true">
            {holding.ticker.replace(/[.-].*$/, '').slice(0, 4)}
          </span>
          <span className="inspector__name">{holding.name}</span>
          <span className="inspector__ticker num">{holding.ticker}</span>
        </span>
      }
      description={
        <>
          {holding.asset_class}
          {holding.region && holding.region !== holding.asset_class ? ` · ${holding.region}` : ''} · today{' '}
          <span className={`num ${signClass(holding.day_change_pct)}`}>{formatPercentSigned(holding.day_change_pct)}</span>
        </>
      }
      footer={
        <>
          {onEdit ? (
            <button type="button" className="button" onClick={() => onEdit(holding)}>
              Edit position
            </button>
          ) : null}
          {onTrade ? (
            <button type="button" className="button button--primary" onClick={() => onTrade(holding.ticker)}>
              Trade {holding.ticker}
            </button>
          ) : null}
        </>
      }
    >
      <div className="inspector__facts">
        <div>
          <span className="label">Position value</span>
          <strong className="num">{formatMoney(holding.value_base)}</strong>
        </div>
        <div>
          <span className="label">Unrealised P&amp;L</span>
          <strong className={`num ${signClass(holding.unrealized_pnl)}`}>
            {formatMoneySigned(holding.unrealized_pnl)}
            <small> {formatPercentSigned(holding.unrealized_pnl_pct, 1)}</small>
          </strong>
        </div>
        <div>
          <span className="label">Weight</span>
          <strong className="num">{formatPercent(holding.allocation_pct)}</strong>
        </div>
      </div>

      <section className="inspector__chart" aria-label="Price over the last 90 sessions">
        <div className="inspector__chart-head">
          {/* The series is priced in the reporting currency, like the day change. */}
          <span className="label">90-session price in {currency}</span>
          <span className="num muted">
            {formatPrice(low, currency)} – {formatPrice(high, currency)} · last {formatPrice(last, currency)}{' '}
            <span className={signClass(trend)}>({formatPercentSigned(trend, 1)})</span>
          </span>
        </div>
        <Sparkline
          values={holding.sparkline}
          width={520}
          height={130}
          area
          fluid
          strokeWidth={2}
          ariaLabel={`${holding.ticker} price over the last 90 trading days`}
        />
      </section>

      <dl className="metadata inspector__details">
        <div>
          <dt>Quantity</dt>
          <dd className="num">{formatQuantity(holding.quantity)}</dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd className="num">
            {formatPrice(holding.price_native, holding.currency)}
            {holding.currency !== currency ? (
              <span className="metadata__sub"> = {formatPrice(holding.price_base, currency)}</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd className="num">
            {formatMoney(holding.cost_total_base)} {currency}
          </dd>
        </div>
        <div>
          <dt>Held since</dt>
          <dd className="num">{formatDate(holding.acquired)}</dd>
        </div>
        {holding.price_effect !== null && holding.fx_effect !== null && holding.currency !== currency ? (
          <div>
            <dt>From price / from FX</dt>
            <dd className="num">
              <span className={signClass(holding.price_effect)}>{formatMoneySigned(holding.price_effect)}</span> /{' '}
              <span className={signClass(holding.fx_effect)}>{formatMoneySigned(holding.fx_effect)}</span>
            </dd>
          </div>
        ) : null}
      </dl>

      <section className="inspector__whatif">
        <div className="inspector__whatif-head">
          <label className="label" htmlFor="inspector-whatif">
            What if this position were worth
          </label>
          <span className="num inspector__whatif-value">
            {formatMoneyCompact(simulated)} {currency} ({formatPercent(newWeight, 1)})
          </span>
        </div>
        <input
          id="inspector-whatif"
          className="inspector__slider"
          type="range"
          min={0}
          max={max}
          step={step}
          value={simulated}
          onChange={(event) => setSimulated(Number(event.target.value))}
          aria-valuetext={`${formatMoneyCompact(simulated)} ${currency}, ${formatPercent(newWeight, 1)} of the portfolio`}
        />
        <div className="inspector__whatif-foot num">
          <span>Sell it all</span>
          <span className="inspector__whatif-delta">
            {unchanged
              ? 'As it is today'
              : `${delta > 0 ? 'Buy' : 'Sell'} ${formatMoneyCompact(Math.abs(delta))} → portfolio ${formatMoneyCompact(newTotal)} ${currency}`}
          </span>
          <span>{formatMoneyCompact(max)}</span>
        </div>
      </section>
    </Dialog>
  )
}
