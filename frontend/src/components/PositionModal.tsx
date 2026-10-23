/**
 * Position window: add a position, or edit one directly.
 *
 * The symbol lookup (/api/v1/instruments/{ticker}) fills in the name,
 * currency and classification; everything stays editable.
 */

import { useEffect, useState } from 'react'

import { Dialog } from './Dialog'

import {
  ApiError,
  createPosition,
  deletePosition,
  lookupInstrument,
  updatePosition,
  type DataConfig,
} from '../lib/api'
import type { InstrumentInfo, Position, PositionInput } from '../lib/types'

interface PositionModalProps {
  isOpen: boolean
  position?: Position | null
  config: DataConfig
  baseCurrency: string
  onClose: () => void
  onSaved: () => void
  onDelete?: (id: number) => Promise<void>
}

interface FormState {
  ticker: string
  name: string
  asset_class: string
  region: string
  currency: string
  quantity: string
  cost_basis_per_unit: string
  acquired: string
  target_weight: string
}

const ASSET_CLASSES = ['Stock', 'ETF', 'Fund', 'Crypto', 'Bond', 'Commodity', 'Cash', 'Other']

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function blankForm(baseCurrency: string): FormState {
  return {
    ticker: '',
    name: '',
    asset_class: 'Stock',
    region: '',
    currency: baseCurrency || 'USD',
    quantity: '',
    cost_basis_per_unit: '',
    acquired: todayIso(),
    target_weight: '',
  }
}

function formFromPosition(pos: Position): FormState {
  return {
    ticker: pos.ticker,
    name: pos.name,
    asset_class: pos.asset_class,
    region: pos.region ?? '',
    currency: pos.currency,
    quantity: String(pos.quantity),
    cost_basis_per_unit: String(pos.cost_basis_per_unit),
    acquired: pos.acquired,
    target_weight:
      pos.target_weight !== null && pos.target_weight !== undefined
        ? String(pos.target_weight * 100)
        : '',
  }
}

export function PositionModal({
  isOpen,
  position,
  config,
  baseCurrency,
  onClose,
  onSaved,
  onDelete,
}: PositionModalProps) {
  const [form, setForm] = useState<FormState>(() => blankForm(baseCurrency))
  const [lookupLoading, setLookupLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [globalError, setGlobalError] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      if (position) {
        setForm(formFromPosition(position))
      } else {
        setForm(blankForm(baseCurrency))
      }
      setErrors({})
      setGlobalError(null)
      setSaving(false)
      setDeleting(false)
    }
  }, [isOpen, position, baseCurrency])

  if (!isOpen) return null

  const isEditing = Boolean(position)

  const setField = (field: keyof FormState) => (value: string) => {
    setForm((curr) => ({ ...curr, [field]: value }))
    if (errors[field]) {
      setErrors((curr) => {
        const next = { ...curr }
        delete next[field]
        return next
      })
    }
  }

  const handleLookup = async () => {
    const sym = form.ticker.trim()
    if (!sym) {
      setErrors((prev) => ({ ...prev, ticker: 'Enter a symbol to look up' }))
      return
    }

    setLookupLoading(true)
    try {
      const info: InstrumentInfo = await lookupInstrument(config, sym)
      setForm((curr) => ({
        ...curr,
        ticker: info.ticker,
        name: curr.name || info.name,
        currency: info.currency || curr.currency,
        asset_class: info.asset_class || curr.asset_class,
        region: info.region || curr.region,
      }))
    } catch {
      // Failed lookup is not fatal, user can still type manually
    } finally {
      setLookupLoading(false)
    }
  }

  const validate = (): PositionInput | null => {
    const errs: Record<string, string> = {}
    const qty = Number.parseFloat(form.quantity.replace(',', '.'))
    const cost = Number.parseFloat(form.cost_basis_per_unit.replace(',', '.'))

    if (!form.ticker.trim()) errs.ticker = 'Enter a symbol'
    if (!form.name.trim()) errs.name = 'Enter a name'
    if (!Number.isFinite(qty) || qty <= 0) errs.quantity = 'Enter a quantity above zero'
    if (!Number.isFinite(cost) || cost < 0) errs.cost_basis_per_unit = 'The cost cannot be negative'
    if (!form.acquired) errs.acquired = 'Enter the date you bought it'

    let targetWeight: number | null = null
    if (form.target_weight.trim()) {
      const tw = Number.parseFloat(form.target_weight.replace(',', '.'))
      if (!Number.isFinite(tw) || tw < 0 || tw > 100) {
        errs.target_weight = 'Enter a percentage from 0 to 100'
      } else {
        targetWeight = tw / 100
      }
    }

    if (Object.keys(errs).length > 0) {
      setErrors(errs)
      return null
    }

    return {
      ticker: form.ticker.trim().toUpperCase(),
      name: form.name.trim(),
      asset_class: form.asset_class,
      region: form.region.trim() || null,
      currency: form.currency.trim().toUpperCase() || 'USD',
      quantity: qty,
      cost_basis_per_unit: cost,
      acquired: form.acquired,
      target_weight: targetWeight,
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const input = validate()
    if (!input) return

    setSaving(true)
    setGlobalError(null)

    try {
      if (isEditing && position) {
        await updatePosition(config, position.id, input)
      } else {
        await createPosition(config, input)
      }
      onSaved()
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.fields.length > 0) {
        const fieldMap: Record<string, string> = {}
        for (const f of err.fields) {
          const key = f.field.replace(/^body\./, '').split('.').slice(-1)[0]
          fieldMap[key] = f.message
        }
        setErrors(fieldMap)
      } else {
        setGlobalError(err instanceof Error ? err.message : 'The position was not saved. Try again.')
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!position || !confirm(`Delete ${position.ticker} from this portfolio?`)) return

    setDeleting(true)
    try {
      if (onDelete) {
        await onDelete(position.id)
      } else {
        await deletePosition(config, position.id)
      }
      onSaved()
      onClose()
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'The position was not deleted. Try again.')
    } finally {
      setDeleting(false)
    }
  }

  const busy = saving || deleting

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      size="lg"
      title={isEditing ? `Edit ${position?.ticker}` : 'Add a position'}
      description={
        isEditing
          ? 'Changing the quantity, cost or date sets the position directly, in place of the trades recorded for it.'
          : 'Look up a symbol to fill in its name and currency, or enter them yourself.'
      }
      onSubmit={handleSubmit}
      footer={
        <>
          {isEditing && (
            <button
              type="button"
              className="button button--danger dialog__footer-start"
              onClick={handleDelete}
              disabled={busy}
            >
              {deleting ? 'Deleting…' : 'Delete position'}
            </button>
          )}
          <button type="button" className="button button--quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={busy}>
            {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Add position'}
          </button>
        </>
      }
    >
      <div className="dialog__grid">
        <div className="field">
          <label className="field__label" htmlFor="position-ticker">
            Symbol
          </label>
          <div className="field__inline">
            <input
              id="position-ticker"
              className="input num"
              type="text"
              placeholder="AAPL, VWCE.DE, BTC-USD"
              value={form.ticker}
              onChange={(e) => setField('ticker')(e.target.value.toUpperCase())}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              required
            />
            <button
              type="button"
              className="button"
              onClick={handleLookup}
              disabled={lookupLoading || !form.ticker.trim()}
            >
              {lookupLoading ? 'Looking up…' : 'Look up'}
            </button>
          </div>
          {errors.ticker && <span className="field__error">{errors.ticker}</span>}
        </div>

        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="input"
            type="text"
            placeholder="Apple Inc."
            value={form.name}
            onChange={(e) => setField('name')(e.target.value)}
            disabled={saving}
            required
          />
          {errors.name && <span className="field__error">{errors.name}</span>}
        </label>

        <label className="field">
          <span className="field__label">Asset class</span>
          <select
            className="input"
            value={form.asset_class}
            onChange={(e) => setField('asset_class')(e.target.value)}
            disabled={saving}
          >
            {ASSET_CLASSES.map((cls) => (
              <option key={cls} value={cls}>
                {cls}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Quoted in</span>
          <input
            className="input num"
            type="text"
            maxLength={3}
            placeholder="USD"
            value={form.currency}
            onChange={(e) => setField('currency')(e.target.value.toUpperCase())}
            disabled={saving}
            autoComplete="off"
            required
          />
        </label>

        <label className="field">
          <span className="field__label">Quantity</span>
          <input
            className="input num"
            type="text"
            inputMode="decimal"
            placeholder="50 or 0.25"
            value={form.quantity}
            onChange={(e) => setField('quantity')(e.target.value)}
            disabled={saving}
            required
          />
          {errors.quantity && <span className="field__error">{errors.quantity}</span>}
        </label>

        <label className="field">
          <span className="field__label">Cost per unit</span>
          <input
            className="input num"
            type="text"
            inputMode="decimal"
            placeholder="175.50"
            value={form.cost_basis_per_unit}
            onChange={(e) => setField('cost_basis_per_unit')(e.target.value)}
            disabled={saving}
            required
          />
          <span className="field__hint">In the currency the position is quoted in.</span>
          {errors.cost_basis_per_unit && (
            <span className="field__error">{errors.cost_basis_per_unit}</span>
          )}
        </label>

        <label className="field">
          <span className="field__label">Bought on</span>
          <input
            className="input num"
            type="date"
            max={todayIso()}
            value={form.acquired}
            onChange={(e) => setField('acquired')(e.target.value)}
            disabled={saving}
            required
          />
          {errors.acquired && <span className="field__error">{errors.acquired}</span>}
        </label>

        <label className="field">
          <span className="field__label">Target weight (optional)</span>
          <input
            className="input num"
            type="text"
            inputMode="decimal"
            placeholder="15"
            value={form.target_weight}
            onChange={(e) => setField('target_weight')(e.target.value)}
            disabled={saving}
          />
          <span className="field__hint">Percent of the portfolio you aim to hold.</span>
          {errors.target_weight && <span className="field__error">{errors.target_weight}</span>}
        </label>
      </div>

      {globalError && (
        <div className="dialog__error" role="alert">
          {globalError}
        </div>
      )}
    </Dialog>
  )
}
