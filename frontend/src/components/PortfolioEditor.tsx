/**
 * Live portfolio editor.
 *
 * Only rendered in API mode: the committed snapshot has no writable database.
 * The form is deliberately explicit about the two fields that most often make a
 * portfolio valuation wrong - quantity and cost basis per unit - and uses the
 * backend's instrument lookup to populate metadata rather than asking the user
 * to type a currency from memory.
 *
 * Validation happens here for immediate feedback and again in the API. Server
 * field errors are mapped back onto the relevant inputs.
 */

import { useState } from 'react'

import {
  ApiError,
  createPosition,
  deletePosition,
  lookupInstrument,
  updatePosition,
  type DataConfig,
} from '../lib/api'
import { formatDate, formatMoney, formatPrice, formatQuantity } from '../lib/format'
import type { InstrumentInfo, Position, PositionInput } from '../lib/types'
import { Panel } from './Panel'

interface PortfolioEditorProps {
  positions: Position[]
  config: DataConfig
  apiKeyRequired: boolean
  baseCurrency: string
  onSaved: () => void
  onApiKey: (key: string) => void
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
}

const ASSET_CLASSES = ['Stock', 'ETF', 'Fund', 'Crypto', 'Bond', 'Cash', 'Other']

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function blankForm(baseCurrency: string): FormState {
  return {
    ticker: '',
    name: '',
    asset_class: 'Stock',
    region: '',
    currency: baseCurrency === 'EUR' ? 'EUR' : 'USD',
    quantity: '',
    cost_basis_per_unit: '',
    acquired: todayIso(),
  }
}

function formFromPosition(position: Position): FormState {
  return {
    ticker: position.ticker,
    name: position.name,
    asset_class: position.asset_class,
    region: position.region ?? '',
    currency: position.currency,
    quantity: String(position.quantity),
    cost_basis_per_unit: String(position.cost_basis_per_unit),
    acquired: position.acquired,
  }
}

function decimal(value: string): number {
  return Number.parseFloat(value.replace(',', '.'))
}

/** Client-side validation with the same rules as the API schema. */
function validate(form: FormState): { input?: PositionInput; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const quantity = decimal(form.quantity)
  const cost = decimal(form.cost_basis_per_unit)

  if (!form.ticker.trim()) errors.ticker = 'Ticker is required.'
  else if (!/^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/i.test(form.ticker.trim())) {
    errors.ticker = 'Use a Yahoo Finance symbol, for example VUSA.AS or BTC-USD.'
  }
  if (!form.name.trim()) errors.name = 'Name is required.'
  if (!Number.isFinite(quantity) || quantity <= 0) {
    errors.quantity = 'Quantity must be greater than zero.'
  }
  if (!Number.isFinite(cost) || cost < 0) {
    errors.cost_basis_per_unit = 'Cost basis must be zero or greater.'
  }
  if (!form.acquired) {
    errors.acquired = 'Acquisition date is required.'
  } else if (form.acquired > todayIso()) {
    errors.acquired = 'Acquisition date cannot be in the future.'
  }
  if (!/^[A-Za-z]{3}$/.test(form.currency)) {
    errors.currency = 'Use a three-letter currency code.'
  }

  if (Object.keys(errors).length > 0) return { errors }

  return {
    errors,
    input: {
      ticker: form.ticker.trim().toUpperCase(),
      name: form.name.trim(),
      asset_class: form.asset_class,
      region: form.region.trim() || null,
      currency: form.currency.trim(),
      quantity,
      cost_basis_per_unit: cost,
      acquired: form.acquired,
    },
  }
}

function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {}
  const mapped: Record<string, string> = {}
  for (const item of error.fields) {
    const key = item.field.replace(/^body\./, '').split('.').slice(-1)[0]
    mapped[key] = item.message
  }
  return mapped
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <span className="field__error">{message}</span>
}

export function PortfolioEditor({
  positions,
  config,
  apiKeyRequired,
  baseCurrency,
  onSaved,
  onApiKey,
}: PortfolioEditorProps) {
  const [form, setForm] = useState<FormState>(() => blankForm(baseCurrency))
  const [editingId, setEditingId] = useState<number | null>(null)
  const [formOpen, setFormOpen] = useState(positions.length === 0)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [unauthorized, setUnauthorized] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [lookup, setLookup] = useState<{ loading: boolean; info?: InstrumentInfo; error?: string }>({
    loading: false,
  })
  const [keyDraft, setKeyDraft] = useState('')

  const set = (field: keyof FormState) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }))

  const resetForm = () => {
    setForm(blankForm(baseCurrency))
    setEditingId(null)
    setErrors({})
    setError(null)
    setUnauthorized(false)
    setLookup({ loading: false })
  }

  const startNew = () => {
    resetForm()
    setFormOpen(true)
  }

  const startEdit = (position: Position) => {
    setForm(formFromPosition(position))
    setEditingId(position.id)
    setErrors({})
    setError(null)
    setUnauthorized(false)
    setLookup({ loading: false })
    setFormOpen(true)
  }

  const runLookup = async () => {
    const ticker = form.ticker.trim()
    if (!ticker) {
      setErrors((current) => ({ ...current, ticker: 'Enter a ticker before looking it up.' }))
      return
    }
    setLookup({ loading: true })
    try {
      const info = await lookupInstrument(config, ticker)
      setLookup({ loading: false, info })
      setForm((current) => ({
        ...current,
        ticker: info.ticker,
        name: info.name || current.name,
        currency: info.currency || current.currency,
        asset_class: info.asset_class || current.asset_class,
        region: info.region ?? current.region,
      }))
      setErrors((current) => {
        const next = { ...current }
        delete next.ticker
        return next
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setLookup({ loading: false, error: message })
      if (cause instanceof ApiError && cause.status === 401) setUnauthorized(true)
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const result = validate(form)
    setErrors(result.errors)
    setError(null)
    setUnauthorized(false)
    if (!result.input) return

    setSaving(true)
    try {
      if (editingId !== null) {
        await updatePosition(config, editingId, result.input)
      } else {
        await createPosition(config, result.input)
      }
      resetForm()
      setFormOpen(positions.length === 0)
      onSaved()
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setUnauthorized(true)
        setError('The API rejected this request because no valid key was supplied.')
      } else {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      setErrors(fieldErrors(cause))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (position: Position) => {
    if (confirmDelete !== position.id) {
      setConfirmDelete(position.id)
      return
    }
    setDeleting(position.id)
    setError(null)
    try {
      await deletePosition(config, position.id)
      setConfirmDelete(null)
      if (editingId === position.id) resetForm()
      onSaved()
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) setUnauthorized(true)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDeleting(null)
    }
  }

  const applyKey = () => {
    onApiKey(keyDraft.trim())
    setKeyDraft('')
    setUnauthorized(false)
  }

  return (
    <Panel
      title="Portfolio editor"
      subtitle={`${positions.length} stored positions · ${baseCurrency} reporting currency`}
      actions={
        <button type="button" className="button button--quiet" onClick={startNew}>
          Add position
        </button>
      }
      className="editor"
    >
      <div className="editor__body">
        <div className="editor__list">
          {positions.length === 0 ? (
            <div className="editor__empty">
              <span className="eyebrow">Empty portfolio</span>
              <p>
                Add the first position. Analytics are rebuilt from the acquisition date, so
                the portfolio&apos;s risk history starts when its earliest asset was bought.
              </p>
              <button type="button" className="button" onClick={startNew}>
                Add the first position
              </button>
            </div>
          ) : (
            <table className="editor__table">
              <thead>
                <tr>
                  <th scope="col">Ticker</th>
                  <th scope="col">Position</th>
                  <th scope="col" className="tabular-right">Quantity</th>
                  <th scope="col" className="tabular-right">Cost / unit</th>
                  <th scope="col">Acquired</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => (
                  <tr key={position.id}>
                    <td className="num editor__ticker">{position.ticker}</td>
                    <td>
                      <span className="editor__name">{position.name}</span>
                      <span className="editor__meta">
                        {position.asset_class}
                        {position.region ? ` · ${position.region}` : ''} · {position.currency}
                      </span>
                    </td>
                    <td className="num tabular-right">{formatQuantity(position.quantity)}</td>
                    <td className="num tabular-right">
                      {formatPrice(position.cost_basis_per_unit, position.currency)}
                    </td>
                    <td className="num editor__date">{formatDate(position.acquired)}</td>
                    <td className="editor__actions">
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => startEdit(position)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={
                          confirmDelete === position.id
                            ? 'text-button text-button--danger'
                            : 'text-button'
                        }
                        onClick={() => void remove(position)}
                        disabled={deleting === position.id}
                      >
                        {deleting === position.id
                          ? 'Deleting'
                          : confirmDelete === position.id
                            ? 'Confirm'
                            : 'Delete'}
                      </button>
                      {confirmDelete === position.id ? (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setConfirmDelete(null)}
                        >
                          Cancel
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {formOpen ? (
          <form className="editor__form" onSubmit={(event) => void submit(event)} noValidate>
            <div className="editor__form-head">
              <span className="label">{editingId === null ? 'New position' : 'Edit position'}</span>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setFormOpen(false)
                  resetForm()
                }}
              >
                Close
              </button>
            </div>

            {error ? <div className="notice notice--error">{error}</div> : null}

            {unauthorized ? (
              <div className="editor__auth">
                <label className="field">
                  <span className="field__label">API key</span>
                  <input
                    className="input"
                    type="password"
                    value={keyDraft}
                    onChange={(event) => setKeyDraft(event.target.value)}
                    placeholder="X-API-Key"
                    autoComplete="off"
                  />
                </label>
                <button type="button" className="button" onClick={applyKey} disabled={!keyDraft.trim()}>
                  Apply key
                </button>
              </div>
            ) : null}

            <div className="editor__grid">
              <label className="field">
                <span className="field__label">Ticker</span>
                <div className="field__inline">
                  <input
                    className="input num"
                    value={form.ticker}
                    onChange={(event) => set('ticker')(event.target.value.toUpperCase())}
                    placeholder="VUSA.AS"
                    autoComplete="off"
                    aria-invalid={Boolean(errors.ticker)}
                  />
                  <button
                    type="button"
                    className="button button--quiet"
                    onClick={() => void runLookup()}
                    disabled={lookup.loading}
                  >
                    {lookup.loading ? 'Looking up' : 'Look up'}
                  </button>
                </div>
                <FieldError message={errors.ticker} />
              </label>

              <label className="field">
                <span className="field__label">Name</span>
                <input
                  className="input"
                  value={form.name}
                  onChange={(event) => set('name')(event.target.value)}
                  placeholder="Vanguard S&P 500 UCITS ETF"
                  aria-invalid={Boolean(errors.name)}
                />
                <FieldError message={errors.name} />
              </label>

              <label className="field">
                <span className="field__label">Asset class</span>
                <select
                  className="input"
                  value={form.asset_class}
                  onChange={(event) => set('asset_class')(event.target.value)}
                >
                  {ASSET_CLASSES.map((assetClass) => (
                    <option key={assetClass} value={assetClass}>
                      {assetClass}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="field__label">Region</span>
                <input
                  className="input"
                  value={form.region}
                  onChange={(event) => set('region')(event.target.value)}
                  placeholder="Global"
                />
              </label>

              <label className="field">
                <span className="field__label">Currency</span>
                <input
                  className="input num"
                  value={form.currency}
                  onChange={(event) => set('currency')(event.target.value.toUpperCase())}
                  maxLength={3}
                  aria-invalid={Boolean(errors.currency)}
                />
                <FieldError message={errors.currency} />
              </label>

              <label className="field">
                <span className="field__label">Quantity</span>
                <input
                  className="input num"
                  inputMode="decimal"
                  value={form.quantity}
                  onChange={(event) => set('quantity')(event.target.value)}
                  placeholder="10"
                  aria-invalid={Boolean(errors.quantity)}
                />
                <FieldError message={errors.quantity} />
              </label>

              <label className="field">
                <span className="field__label">Cost basis / unit</span>
                <input
                  className="input num"
                  inputMode="decimal"
                  value={form.cost_basis_per_unit}
                  onChange={(event) => set('cost_basis_per_unit')(event.target.value)}
                  placeholder="82.40"
                  aria-invalid={Boolean(errors.cost_basis_per_unit)}
                />
                <FieldError message={errors.cost_basis_per_unit} />
              </label>

              <label className="field">
                <span className="field__label">Acquired</span>
                <input
                  className="input num"
                  type="date"
                  value={form.acquired}
                  max={todayIso()}
                  onChange={(event) => set('acquired')(event.target.value)}
                  aria-invalid={Boolean(errors.acquired)}
                />
                <FieldError message={errors.acquired} />
              </label>
            </div>

            {lookup.info ? (
              <p className="editor__lookup">
                Matched <span className="num">{lookup.info.ticker}</span> ·{' '}
                {lookup.info.name} · {lookup.info.currency}
                {lookup.info.last_price !== null ? (
                  <>
                    {' '}· last {formatMoney(lookup.info.last_price)} on{' '}
                    {formatDate(lookup.info.as_of)}
                  </>
                ) : null}
                {lookup.info.estimated ? ' · metadata estimated' : ''}
              </p>
            ) : null}
            {lookup.error ? <p className="editor__lookup neg">{lookup.error}</p> : null}

            <div className="editor__form-footer">
              <p className="editor__hint">
                Stored positions, not trades. Quantity and cost are current totals; the
                acquisition date activates the position in the time series.
              </p>
              <button type="submit" className="button button--primary" disabled={saving}>
                {saving ? 'Saving' : editingId === null ? 'Add position' : 'Save changes'}
              </button>
            </div>

            {apiKeyRequired ? (
              <p className="editor__hint">
                This API requires an <code>X-API-Key</code>. You will be prompted here if a
                request is rejected.
              </p>
            ) : null}
          </form>
        ) : null}
      </div>
    </Panel>
  )
}
