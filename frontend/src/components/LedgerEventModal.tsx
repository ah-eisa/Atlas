/**
 * Record anything that is not a trade: a dividend, a fee or a tax, a
 * corporate action (split, symbol change or merger, spin-off, return of
 * capital) or a currency conversion.
 *
 * Each kind asks only for what it needs. The backend rebuilds the positions
 * from the whole ledger and refuses an entry that cannot apply (a split of a
 * position not held on its date); the reason is shown here as it comes back.
 */

import { useEffect, useState } from 'react'

import { ApiError, createLedgerEvent, type DataConfig } from '../lib/api'
import type { LedgerEventInput, LedgerEventKind, Position } from '../lib/types'
import { Dialog } from './Dialog'

interface LedgerEventModalProps {
  isOpen: boolean
  positions: Position[]
  config: DataConfig
  baseCurrency: string
  initialKind?: LedgerEventKind
  onClose: () => void
  onSaved: () => void
}

const KINDS: { value: LedgerEventKind; label: string; hint: string }[] = [
  { value: 'DIVIDEND', label: 'Dividend', hint: 'Cash paid by a holding. The tax withheld from it is recorded with it.' },
  { value: 'FEE', label: 'Fee', hint: 'A charge paid from the portfolio: custody, platform or advice.' },
  { value: 'TAX', label: 'Tax', hint: 'Tax paid from the portfolio, on its own or for a holding.' },
  { value: 'SPLIT', label: 'Split', hint: 'More (or, reversed, fewer) units for the same holding. The cost stays the same.' },
  {
    value: 'SYMBOL_CHANGE',
    label: 'Symbol change',
    hint: 'A new ticker, or a merger paid in shares: the units move to the new instrument with their cost and dates.',
  },
  {
    value: 'SPINOFF',
    label: 'Spin-off',
    hint: 'Units of a new company received for a holding, taking part of its cost with them.',
  },
  {
    value: 'RETURN_OF_CAPITAL',
    label: 'Return of capital',
    hint: 'Capital paid back to holders. It lowers the cost; anything beyond the cost is a gain.',
  },
  { value: 'FX', label: 'Currency conversion', hint: 'Cash changed from one currency to another.' },
]

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function parse(value: string): number {
  return Number.parseFloat(value.replace(',', '.')) || 0
}

export function LedgerEventModal({
  isOpen,
  positions,
  config,
  baseCurrency,
  initialKind = 'DIVIDEND',
  onClose,
  onSaved,
}: LedgerEventModalProps) {
  const [kind, setKind] = useState<LedgerEventKind>(initialKind)
  const [occurredOn, setOccurredOn] = useState(todayIso())
  const [ticker, setTicker] = useState('')
  const [newTicker, setNewTicker] = useState('')
  const [amount, setAmount] = useState('')
  const [tax, setTax] = useState('')
  const [fee, setFee] = useState('')
  const [currency, setCurrency] = useState('')
  const [ratio, setRatio] = useState('')
  const [costShare, setCostShare] = useState('')
  const [toCurrency, setToCurrency] = useState('')
  const [toAmount, setToAmount] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setKind(initialKind)
    setOccurredOn(todayIso())
    setTicker(positions[0]?.ticker ?? '')
    setNewTicker('')
    setAmount('')
    setTax('')
    setFee('')
    setCurrency('')
    setRatio('')
    setCostShare('')
    setToCurrency('')
    setToAmount('')
    setNote('')
    setError(null)
    setSaving(false)
  }, [isOpen, initialKind, positions])

  if (!isOpen) return null

  const selected = KINDS.find((item) => item.value === kind) ?? KINDS[0]
  const position = positions.find((p) => p.ticker.toUpperCase() === ticker.trim().toUpperCase())
  const needsTicker = kind !== 'FX'
  const tickerOptional = kind === 'FEE' || kind === 'TAX'
  const needsAmount = kind === 'DIVIDEND' || kind === 'FEE' || kind === 'TAX' || kind === 'RETURN_OF_CAPITAL' || kind === 'FX'
  const needsRatio = kind === 'SPLIT' || kind === 'SYMBOL_CHANGE' || kind === 'SPINOFF'
  const needsNewTicker = kind === 'SYMBOL_CHANGE' || kind === 'SPINOFF'
  const paidIn = currency.trim().toUpperCase() || position?.currency || baseCurrency

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const input: LedgerEventInput = { kind, occurred_on: occurredOn, note: note.trim() }
    if (needsTicker && (ticker.trim() || !tickerOptional)) {
      if (!ticker.trim()) {
        setError('Choose the holding this is for.')
        return
      }
      input.ticker = ticker.trim().toUpperCase()
    }
    if (needsAmount) {
      if (parse(amount) <= 0) {
        setError(kind === 'FX' ? 'Enter the amount converted.' : 'Enter an amount above zero.')
        return
      }
      input.amount = parse(amount)
      input.currency = currency.trim().toUpperCase() || null
    }
    if (kind === 'DIVIDEND') input.tax = parse(tax)
    if (needsRatio) {
      if (parse(ratio) <= 0) {
        setError('Enter how many new units each unit becomes, above zero.')
        return
      }
      input.ratio = parse(ratio)
    }
    if (needsNewTicker) {
      if (!newTicker.trim()) {
        setError('Enter the ticker of the instrument received.')
        return
      }
      input.new_ticker = newTicker.trim().toUpperCase()
    }
    if (kind === 'SPINOFF') input.cost_fraction = parse(costShare) / 100
    if (kind === 'FX') {
      if (!currency.trim() || !toCurrency.trim() || parse(toAmount) <= 0) {
        setError('Enter both currencies and the amount received.')
        return
      }
      input.to_currency = toCurrency.trim().toUpperCase()
      input.to_amount = parse(toAmount)
      input.fee = parse(fee)
    }

    setSaving(true)
    setError(null)
    try {
      await createLedgerEvent(config, input)
      onSaved()
      onClose()
    } catch (cause) {
      setError(
        cause instanceof ApiError || cause instanceof Error ? cause.message : 'The entry was not recorded. Try again.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      size="lg"
      title="Record in the ledger"
      description="Income, charges, corporate actions and currency conversions. Trades are recorded with Trade."
      onSubmit={handleSubmit}
      footer={
        <>
          <button type="button" className="button button--quiet" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={saving}>
            {saving ? 'Recording…' : `Record ${selected.label.toLowerCase()}`}
          </button>
        </>
      }
    >
      <div className="choice choice--wrap" role="radiogroup" aria-label="Kind of entry">
        {KINDS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={kind === item.value}
            className="choice__option"
            onClick={() => {
              setKind(item.value)
              setError(null)
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="field__hint ledger-form__hint">{selected.hint}</p>

      <div className="dialog__grid">
        <label className="field">
          <span className="field__label">{kind === 'DIVIDEND' ? 'Paid on' : 'Date'}</span>
          <input
            className="input num"
            type="date"
            max={todayIso()}
            value={occurredOn}
            onChange={(e) => setOccurredOn(e.target.value)}
            disabled={saving}
            required
          />
        </label>

        {needsTicker ? (
          <label className="field">
            <span className="field__label">
              {needsNewTicker ? 'Holding (old ticker)' : tickerOptional ? 'Holding (optional)' : 'Holding'}
            </span>
            <input
              className="input num"
              type="text"
              list="ledger-holdings"
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              data-autofocus
            />
            <datalist id="ledger-holdings">
              {positions.map((p) => (
                <option key={p.ticker} value={p.ticker}>
                  {p.name}
                </option>
              ))}
            </datalist>
            {position ? <span className="field__hint">{position.name}</span> : null}
          </label>
        ) : null}

        {needsNewTicker ? (
          <label className="field">
            <span className="field__label">{kind === 'SPINOFF' ? 'New company' : 'New ticker'}</span>
            <input
              className="input num"
              type="text"
              value={newTicker}
              onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        ) : null}

        {needsRatio ? (
          <label className="field">
            <span className="field__label">
              {kind === 'SPLIT' ? 'New units per unit held' : 'Units received per unit held'}
            </span>
            <input
              className="input num"
              type="text"
              inputMode="decimal"
              placeholder={kind === 'SPLIT' ? '4 for a 4-for-1, 0.1 for 1-for-10' : '1'}
              value={ratio}
              onChange={(e) => setRatio(e.target.value)}
              disabled={saving}
            />
          </label>
        ) : null}

        {kind === 'SPINOFF' ? (
          <label className="field">
            <span className="field__label">Share of the cost that moves (%)</span>
            <input
              className="input num"
              type="text"
              inputMode="decimal"
              placeholder="As the company reports it, e.g. 18.5"
              value={costShare}
              onChange={(e) => setCostShare(e.target.value)}
              disabled={saving}
            />
          </label>
        ) : null}

        {needsAmount ? (
          <label className="field">
            <span className="field__label">
              {kind === 'DIVIDEND'
                ? 'Gross amount'
                : kind === 'FX'
                  ? 'Amount converted'
                  : kind === 'RETURN_OF_CAPITAL'
                    ? 'Total received'
                    : 'Amount'}
            </span>
            <input
              className="input num"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={saving}
            />
          </label>
        ) : null}

        {needsAmount ? (
          <label className="field">
            <span className="field__label">{kind === 'FX' ? 'From currency' : 'Currency'}</span>
            <input
              className="input num"
              type="text"
              maxLength={3}
              placeholder={kind === 'FX' ? baseCurrency : paidIn}
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              disabled={saving}
            />
          </label>
        ) : null}

        {kind === 'DIVIDEND' ? (
          <label className="field">
            <span className="field__label">Tax withheld</span>
            <input
              className="input num"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={tax}
              onChange={(e) => setTax(e.target.value)}
              disabled={saving}
            />
            <span className="field__hint">The portfolio receives the gross amount less this, in {paidIn}</span>
          </label>
        ) : null}

        {kind === 'FX' ? (
          <>
            <label className="field">
              <span className="field__label">To currency</span>
              <input
                className="input num"
                type="text"
                maxLength={3}
                value={toCurrency}
                onChange={(e) => setToCurrency(e.target.value.toUpperCase())}
                disabled={saving}
              />
            </label>
            <label className="field">
              <span className="field__label">Amount received</span>
              <input
                className="input num"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={toAmount}
                onChange={(e) => setToAmount(e.target.value)}
                disabled={saving}
              />
            </label>
            <label className="field">
              <span className="field__label">Fee (optional)</span>
              <input
                className="input num"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={fee}
                onChange={(e) => setFee(e.target.value)}
                disabled={saving}
              />
              <span className="field__hint">In the currency converted from</span>
            </label>
          </>
        ) : null}

        <label className="field dialog__span">
          <span className="field__label">Note (optional)</span>
          <input
            className="input"
            type="text"
            placeholder="Broker reference, what it was for"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={saving}
          />
        </label>
      </div>

      {error && (
        <div className="dialog__error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  )
}
