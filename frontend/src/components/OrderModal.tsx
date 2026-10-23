/**
 * Trade window: record a buy or a sale.
 *
 * The backend matches sales against the oldest lots first; the gain shown
 * here before submitting is an estimate at the average cost, and says so.
 */

import { useEffect, useState } from 'react'

import { Dialog } from './Dialog'

import {
  ApiError,
  lookupInstrument,
  placeOrder,
  type DataConfig,
} from '../lib/api'
import { formatMoney, formatMoneySigned, signClass } from '../lib/format'
import type { InstrumentInfo, OrderType, Position } from '../lib/types'

interface OrderModalProps {
  isOpen: boolean
  positions: Position[]
  config: DataConfig
  baseCurrency: string
  initialTicker?: string
  initialType?: OrderType
  onClose: () => void
  onSaved: () => void
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function OrderModal({
  isOpen,
  positions,
  config,
  baseCurrency,
  initialTicker = '',
  initialType = 'BUY',
  onClose,
  onSaved,
}: OrderModalProps) {
  const [orderType, setOrderType] = useState<OrderType>(initialType)
  const [ticker, setTicker] = useState(initialTicker)
  const [quantity, setQuantity] = useState('')
  const [price, setPrice] = useState('')
  const [executedAt, setExecutedAt] = useState(todayIso())
  const [notes, setNotes] = useState('')
  const [lookupLoading, setLookupLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [instrumentName, setInstrumentName] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      setOrderType(initialType)
      setTicker(initialTicker)
      setQuantity('')
      setPrice('')
      setExecutedAt(todayIso())
      setNotes('')
      setError(null)
      setSaving(false)
      setInstrumentName(null)
      if (initialTicker) {
        const owned = positions.find(
          (p) => p.ticker.toUpperCase() === initialTicker.toUpperCase(),
        )
        if (owned) {
          setInstrumentName(owned.name)
          setPrice(String(owned.cost_basis_per_unit))
        }
      }
    }
  }, [isOpen, initialTicker, initialType, positions])

  if (!isOpen) return null

  const ownedPosition = positions.find(
    (p) => p.ticker.toUpperCase() === ticker.trim().toUpperCase(),
  )

  const numQty = Number.parseFloat(quantity.replace(',', '.')) || 0
  const numPrice = Number.parseFloat(price.replace(',', '.')) || 0
  const totalNotional = numQty * numPrice

  // Estimated Realized P&L if selling
  let estimatedRealizedPnl: number | null = null
  if (orderType === 'SELL' && ownedPosition && numQty > 0) {
    estimatedRealizedPnl = (numPrice - ownedPosition.cost_basis_per_unit) * numQty
  }

  const handleLookup = async () => {
    const sym = ticker.trim()
    if (!sym) return

    setLookupLoading(true)
    try {
      const info: InstrumentInfo = await lookupInstrument(config, sym)
      setInstrumentName(info.name)
      if (info.last_price && !price) {
        setPrice(String(info.last_price))
      }
    } catch {
      // Lookup failure is non-fatal
    } finally {
      setLookupLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const sym = ticker.trim().toUpperCase()
    if (!sym) {
      setError('Enter the symbol you are trading.')
      return
    }
    if (numQty <= 0) {
      setError('Enter a quantity above zero.')
      return
    }
    if (numPrice < 0) {
      setError('The price cannot be negative.')
      return
    }
    if (orderType === 'SELL') {
      if (!ownedPosition) {
        setError(`${sym} is not in this portfolio, so there is nothing to sell.`)
        return
      }
      if (ownedPosition.quantity < numQty) {
        setError(`You hold ${ownedPosition.quantity} ${sym}. Enter ${ownedPosition.quantity} or less.`)
        return
      }
    }

    setSaving(true)
    setError(null)

    try {
      await placeOrder(config, {
        ticker: sym,
        order_type: orderType,
        quantity: numQty,
        price: numPrice,
        executed_at: executedAt,
        notes: notes.trim(),
      })
      onSaved()
      onClose()
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : 'The order was not recorded. Try again.')
      }
    } finally {
      setSaving(false)
    }
  }

  const currency = ownedPosition?.currency || baseCurrency
  const side = orderType === 'BUY' ? 'Buy' : 'Sell'
  const submitLabel = saving
    ? orderType === 'BUY'
      ? 'Buying…'
      : 'Selling…'
    : `${side}${numQty > 0 ? ` ${numQty}` : ''}${ticker.trim() ? ` ${ticker.trim()}` : ''}`

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      size="lg"
      title="Trade"
      description="Record a buy or a sale. A sale is matched against your oldest units first."
      onSubmit={handleSubmit}
      footer={
        <>
          <button type="button" className="button button--quiet" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="submit"
            className={`button ${orderType === 'BUY' ? 'button--primary' : 'button--danger'}`}
            disabled={saving || numQty <= 0}
          >
            {submitLabel}
          </button>
        </>
      }
    >
      <div className="choice" role="radiogroup" aria-label="Order side">
        {(['BUY', 'SELL'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={orderType === value}
            className={`choice__option choice__option--${value === 'BUY' ? 'buy' : 'sell'}`}
            onClick={() => {
              setOrderType(value)
              setError(null)
            }}
          >
            {value === 'BUY' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>

      <div className="dialog__grid">
        <div className="field">
          <label className="field__label" htmlFor="order-ticker">
            Symbol
          </label>
          <div className="field__inline">
            <input
              id="order-ticker"
              className="input num"
              type="text"
              placeholder="AAPL, VWCE.DE, BTC-USD"
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              onBlur={handleLookup}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              required
              data-autofocus={initialTicker ? undefined : true}
            />
            <button
              type="button"
              className="button"
              onClick={handleLookup}
              disabled={lookupLoading || !ticker.trim()}
            >
              {lookupLoading ? 'Looking up…' : 'Look up'}
            </button>
          </div>
          {instrumentName && <span className="field__hint">{instrumentName}</span>}
        </div>

        <label className="field">
          <span className="field__label">Date</span>
          <input
            className="input num"
            type="date"
            max={todayIso()}
            value={executedAt}
            onChange={(e) => setExecutedAt(e.target.value)}
            disabled={saving}
            required
          />
        </label>

        <label className="field">
          <span className="field__label">Quantity</span>
          <input
            className="input num"
            type="text"
            inputMode="decimal"
            placeholder="10 or 0.5"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            disabled={saving}
            required
            data-autofocus={initialTicker ? true : undefined}
          />
          {ownedPosition && (
            <span className="field__hint">
              You hold {ownedPosition.quantity} at an average of{' '}
              {formatMoney(ownedPosition.cost_basis_per_unit)} {ownedPosition.currency}
            </span>
          )}
        </label>

        <label className="field">
          <span className="field__label">Price per unit</span>
          <input
            className="input num"
            type="text"
            inputMode="decimal"
            placeholder="182.50"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={saving}
            required
          />
        </label>

        <label className="field dialog__span">
          <span className="field__label">Note (optional)</span>
          <input
            className="input"
            type="text"
            placeholder="Broker reference, reason for the trade"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={saving}
          />
        </label>
      </div>

      <div className="dialog__summary" aria-live="polite">
        <div className="dialog__summary-row">
          <span>Total</span>
          <span className="dialog__summary-value">
            {formatMoney(totalNotional)} {currency}
          </span>
        </div>
        {orderType === 'SELL' && estimatedRealizedPnl !== null && (
          <>
            <div className="dialog__summary-row">
              <span>Estimated gain or loss</span>
              <span className={`dialog__summary-value ${signClass(estimatedRealizedPnl)}`}>
                {formatMoneySigned(estimatedRealizedPnl)} {currency}
              </span>
            </div>
            <span className="dialog__summary-note">
              Estimated at your average cost. The recorded figure uses the cost of the oldest
              units sold, so it can differ.
            </span>
          </>
        )}
      </div>

      {error && (
        <div className="dialog__error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  )
}
