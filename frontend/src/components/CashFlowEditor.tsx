/**
 * The cash-flow ledger.
 *
 * The time-weighted return excludes external money: a contribution is not
 * performance. The only way to know what was contributed, and when, is to
 * record it. When this ledger has any entry it becomes authoritative, and
 * the flows estimated from position acquisition dates are no longer used.
 *
 * That distinction is stated in the interface, because it changes how every
 * return figure should be read.
 */

import { useState } from 'react'

import {
  ApiError,
  createCashFlow,
  deleteCashFlow,
  type DataConfig,
} from '../lib/api'
import { formatDate, formatMoneySigned, signClass } from '../lib/format'
import type { CashFlow } from '../lib/types'
import { Panel } from './Panel'

interface CashFlowEditorProps {
  cashFlows: CashFlow[]
  config: DataConfig
  baseCurrency: string
  onSaved: () => void
  onApiKey: (key: string) => void
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function CashFlowEditor({
  cashFlows,
  config,
  baseCurrency,
  onSaved,
  onApiKey,
}: CashFlowEditorProps) {
  const [date, setDate] = useState(todayIso())
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [unauthorized, setUnauthorized] = useState(false)

  const total = cashFlows.reduce((sum, flow) => sum + flow.amount, 0)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const value = Number.parseFloat(amount.replace(',', '.'))
    if (!Number.isFinite(value) || value === 0) {
      setError('Enter the amount that moved: positive for a contribution, negative for a withdrawal.')
      return
    }
    if (!date) {
      setError('Choose the date the money moved.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await createCashFlow(config, { occurred_on: date, amount: value, note })
      setAmount('')
      setNote('')
      onSaved()
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setUnauthorized(true)
        setError('The API rejected this request because no valid key was supplied.')
      } else {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      setSaving(false)
    }
  }

  const remove = async (flow: CashFlow) => {
    setDeleting(flow.id)
    setError(null)
    try {
      await deleteCashFlow(config, flow.id)
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
      title="Cash flows"
      subtitle={
        cashFlows.length > 0
          ? `${cashFlows.length} recorded · net ${formatMoneySigned(total)} ${baseCurrency}`
          : 'contributions and withdrawals, by date'
      }
    >
      <div className="flows">
        {cashFlows.length === 0 ? (
          <p className="flows__empty">
            No cash flows recorded. The analytics are currently estimating contributions
            from the dates the positions were acquired. Recording the money that actually
            moved replaces that estimate with the truth.
          </p>
        ) : (
          <table className="flows__table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col" className="tabular-right">Amount</th>
                <th scope="col">Note</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {cashFlows.map((flow) => (
                <tr key={flow.id}>
                  <td className="num flows__date">{formatDate(flow.occurred_on)}</td>
                  <td className={`num tabular-right ${signClass(flow.amount)}`}>
                    {formatMoneySigned(flow.amount)}
                  </td>
                  <td className="flows__note">{flow.note || '—'}</td>
                  <td className="flows__actions">
                    <button
                      type="button"
                      className="text-button text-button--danger"
                      onClick={() => void remove(flow)}
                      disabled={deleting === flow.id}
                    >
                      {deleting === flow.id ? 'Deleting' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="num">Net</td>
                <td className={`num tabular-right ${signClass(total)}`}>
                  {formatMoneySigned(total)}
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        )}

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

        <form className="flows__form" onSubmit={(event) => void submit(event)} noValidate>
          <label className="field">
            <span className="field__label">Date</span>
            <input
              className="input num"
              type="date"
              value={date}
              max={todayIso()}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">Amount ({baseCurrency})</span>
            <input
              className="input num"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="5000 or -1200"
            />
          </label>
          <label className="field flows__note-field">
            <span className="field__label">Note</span>
            <input
              className="input"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Monthly contribution"
              maxLength={200}
            />
          </label>
          <button type="submit" className="button button--primary" disabled={saving}>
            {saving ? 'Saving' : 'Record flow'}
          </button>
        </form>
      </div>
    </Panel>
  )
}
