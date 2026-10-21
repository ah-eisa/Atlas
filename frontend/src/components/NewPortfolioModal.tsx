/**
 * New Portfolio Creation Modal.
 *
 * Allows users to easily create a new tracked portfolio with a custom name
 * and reporting base currency.
 */

import { useEffect, useRef, useState } from 'react'

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
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Please provide a portfolio name.')
      return
    }

    const finalCurrency = currency === 'OTHER' ? customCurrency.trim().toUpperCase() : currency
    if (!/^[A-Z]{3}$/.test(finalCurrency)) {
      setError('Currency must be a 3-letter code (e.g. USD, EUR, SAR).')
      return
    }

    setSaving(true)
    setError(null)
    try {
      await onSubmit(trimmed, finalCurrency)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create portfolio.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-card__header">
          <div>
            <h2 id="modal-title" className="modal-card__title">
              Create New Portfolio
            </h2>
            <p className="modal-card__subtitle">
              Configure a dedicated tracking portfolio with its own positions and reporting currency.
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
          <label className="field">
            <span className="field__label">Portfolio Name</span>
            <input
              ref={inputRef}
              className="input"
              type="text"
              placeholder="e.g. US Tech & Dividend, Retirement, Crypto"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={saving}
              required
            />
          </label>

          <label className="field">
            <span className="field__label">Reporting Base Currency</span>
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
              <option value="OTHER">Other (Custom 3-letter Code)...</option>
            </select>
          </label>

          {currency === 'OTHER' && (
            <label className="field">
              <span className="field__label">Custom Currency Code</span>
              <input
                className="input num"
                type="text"
                maxLength={3}
                placeholder="e.g. KWD, QAR, SGD"
                value={customCurrency}
                onChange={(e) => setCustomCurrency(e.target.value.toUpperCase())}
                disabled={saving}
                required
              />
            </label>
          )}

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
            <button type="submit" className="button button--primary" disabled={saving}>
              {saving ? 'Creating...' : 'Create Portfolio'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
