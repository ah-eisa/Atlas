/**
 * New portfolio window: a name and the currency it reports in.
 */

import { useEffect, useRef, useState } from 'react'

import { Dialog } from './Dialog'

interface NewPortfolioModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (name: string, baseCurrency: string) => Promise<void>
}

const COMMON_CURRENCIES = [
  { code: 'USD', name: 'USD - US Dollar ($)' },
  { code: 'EUR', name: 'EUR - Euro (€)' },
  { code: 'GBP', name: 'GBP - British Pound (£)' },
  { code: 'SAR', name: 'SAR - Saudi Riyal (ر.س)' },
  { code: 'AED', name: 'AED - UAE Dirham (د.إ)' },
  { code: 'EGP', name: 'EGP - Egyptian Pound (ج.م)' },
  { code: 'CHF', name: 'CHF - Swiss Franc' },
  { code: 'CAD', name: 'CAD - Canadian Dollar (C$)' },
  { code: 'JPY', name: 'JPY - Japanese Yen (¥)' },
  { code: 'AUD', name: 'AUD - Australian Dollar (A$)' },
]

export function NewPortfolioModal({ isOpen, onClose, onSubmit }: NewPortfolioModalProps) {
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [customCurrency, setCustomCurrency] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setName('')
      setCurrency('USD')
      setCustomCurrency('')
      setError(null)
      setSaving(false)
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Give the portfolio a name.')
      return
    }

    const finalCurrency = currency === 'OTHER' ? customCurrency.trim().toUpperCase() : currency
    if (!/^[A-Z]{3}$/.test(finalCurrency)) {
      setError('Enter a three-letter currency code, such as USD or SAR.')
      return
    }

    setSaving(true)
    setError(null)
    try {
      await onSubmit(trimmed, finalCurrency)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The portfolio was not created. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      size="sm"
      title="New portfolio"
      description="A separate set of positions, reported in its own currency."
      onSubmit={handleSubmit}
      initialFocusRef={inputRef}
      footer={
        <>
          <button type="button" className="button button--quiet" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={saving}>
            {saving ? 'Creating…' : 'Create portfolio'}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field__label">Name</span>
        <input
          ref={inputRef}
          className="input"
          type="text"
          placeholder="Retirement, Dividends, Crypto"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={saving}
          required
        />
      </label>

      <label className="field">
        <span className="field__label">Reporting currency</span>
        <select
          className="input"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          disabled={saving}
        >
          {COMMON_CURRENCIES.map((curr) => (
            <option key={curr.code} value={curr.code}>
              {curr.name}
            </option>
          ))}
          <option value="OTHER">Another currency…</option>
        </select>
      </label>

      {currency === 'OTHER' && (
        <label className="field">
          <span className="field__label">Currency code</span>
          <input
            className="input num"
            type="text"
            maxLength={3}
            placeholder="KWD, QAR, SGD"
            value={customCurrency}
            onChange={(e) => setCustomCurrency(e.target.value.toUpperCase())}
            disabled={saving}
            autoComplete="off"
            required
          />
        </label>
      )}

      {error && (
        <div className="dialog__error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  )
}
