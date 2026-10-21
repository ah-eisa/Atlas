/**
 * Order Execution Modal - Buy & Sell trades with FIFO lot-matching.
 *
 * Merged from PortfolioManager: provides an institutional trade entry
 * dialog supporting market order execution, real-time position checking,
 * rolling average cost tracking on BUY, and realized P&L calculation on SELL.
 */

import { useEffect, useState } from 'react'

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
      setError('Please provide a symbol/ticker.')
      return
    }
    if (numQty <= 0) {
      setError('Quantity must be greater than zero.')
      return
    }
    if (numPrice < 0) {
      setError('Price cannot be negative.')
      return
    }
    if (orderType === 'SELL') {
      if (!ownedPosition) {
        setError(`Cannot sell ${sym}: you do not hold this asset in this portfolio.`)
        return
      }
      if (ownedPosition.quantity < numQty) {
        setError(
          `Insufficient shares: portfolio holds ${ownedPosition.quantity} units, cannot sell ${numQty}.`,
        )
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
        setError(err instanceof Error ? err.message : 'Failed to execute order.')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-card modal-card--wide"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-modal-title"
      >
        <div className="modal-card__header">
          <div>
            <h2 id="order-modal-title" className="modal-card__title">
              Execute Trade Order
            </h2>
            <p className="modal-card__subtitle">
              Place a BUY or SELL order with automatic FIFO lot matching and rolling cost recalculation.
            </p>
          </div>
          <button
            type="button"
            className="modal-card__close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-card__form">
          {/* Order Side Selector: BUY / SELL */}
          <div className="trade-side-selector">
            <button
              type="button"
              className={`trade-side-btn trade-side-btn--buy ${
                orderType === 'BUY' ? 'trade-side-btn--active' : ''
              }`}
              onClick={() => {
                setOrderType('BUY')
                setError(null)
              }}
            >
              ▲ BUY (شراء)
            </button>
            <button
              type="button"
              className={`trade-side-btn trade-side-btn--sell ${
                orderType === 'SELL' ? 'trade-side-btn--active' : ''
              }`}
              onClick={() => {
                setOrderType('SELL')
                setError(null)
              }}
            >
              ▼ SELL (بيع)
            </button>
          </div>

          <div className="modal-card__grid">
            <div className="field">
              <span className="field__label">Symbol / Ticker</span>
              <div className="field__inline">
                <input
                  className="input num"
                  type="text"
                  placeholder="e.g. AAPL, NVDA, BTC-USD"
                  value={ticker}
                  onChange={(e) => setTicker(e.target.value.toUpperCase())}
                  onBlur={handleLookup}
                  disabled={saving || lookupLoading}
                  required
                />
                <button
                  type="button"
                  className="button"
                  onClick={handleLookup}
                  disabled={lookupLoading || !ticker.trim()}
                >
                  {lookupLoading ? '...' : 'Lookup'}
                </button>
              </div>
              {instrumentName && (
                <span className="panel__subtitle" style={{ marginTop: '2px', display: 'block' }}>
                  {instrumentName}
                </span>
              )}
            </div>

            <label className="field">
              <span className="field__label">Execution Date</span>
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
              <span className="field__label">Quantity (Shares / Units)</span>
              <input
                className="input num"
                type="text"
                placeholder="e.g. 10 or 0.5"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                disabled={saving}
                required
              />
              {ownedPosition && (
                <span className="field__hint">
                  Owned: {ownedPosition.quantity} units (Avg: {formatMoney(ownedPosition.cost_basis_per_unit)})
                </span>
              )}
            </label>

            <label className="field">
              <span className="field__label">Execution Price (per unit)</span>
              <input
                className="input num"
                type="text"
                placeholder="e.g. 182.50"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                disabled={saving}
                required
              />
            </label>
          </div>

          <label className="field">
            <span className="field__label">Order Notes / Broker Reference (Optional)</span>
            <input
              className="input"
              type="text"
              placeholder="e.g. IBKR limit fill, DCA monthly allocation"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={saving}
            />
          </label>

          {/* Trade Summary Strip */}
          <div className="trade-preview-card">
            <div className="trade-preview-row">
              <span className="trade-preview-label">Estimated Notional Value:</span>
              <span className="trade-preview-value num">
                {formatMoney(totalNotional)} {ownedPosition?.currency || baseCurrency}
              </span>
            </div>
            {orderType === 'SELL' && estimatedRealizedPnl !== null && (
              <div className="trade-preview-row">
                <span className="trade-preview-label">Estimated Realized P&L:</span>
                <span className={`trade-preview-value num ${signClass(estimatedRealizedPnl)}`}>
                  {formatMoneySigned(estimatedRealizedPnl)} {ownedPosition?.currency || baseCurrency}
                </span>
              </div>
            )}
          </div>

          {error && <div className="modal-card__error">{error}</div>}

          <div className="modal-card__actions">
            <button
              type="button"
              className="button button--quiet"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`button ${orderType === 'BUY' ? 'button--primary' : 'button--danger'}`}
              disabled={saving || numQty <= 0}
            >
              {saving
                ? 'Executing...'
                : orderType === 'BUY'
                ? `Confirm BUY ${numQty > 0 ? numQty : ''} ${ticker}`
                : `Confirm SELL ${numQty > 0 ? numQty : ''} ${ticker}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
