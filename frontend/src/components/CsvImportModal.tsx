import { useState } from 'react'
import { commitCsvImport, type DataConfig, previewCsvImport } from '../lib/api'
import { formatMoney } from '../lib/format'
import type { CsvImportPreview } from '../lib/types'

interface CsvImportModalProps {
  isOpen: boolean
  onClose: () => void
  config: DataConfig
  baseCurrency: string
  onImportSuccess: () => void
}

const SAMPLE_ATLAS_CSV = `kind,ticker,name,asset_class,region,currency,quantity,cost_basis_per_unit,acquired
position,AAPL,Apple Inc.,Stock,US,USD,25,185.50,2025-01-15
position,NVDA,NVIDIA Corp.,Stock,US,USD,40,118.20,2025-02-01
position,VWCE.DE,Vanguard FTSE All-World,ETF,Global,EUR,50,115.00,2025-01-10
trade,MSFT,BUY,15,410.00,2025-03-01,IBKR Execution
cash_flow,,,,,5000,,2025-01-01,Capital deposit`

const SAMPLE_IBKR_CSV = `Symbol,Description,AssetCategory,Quantity,T. Price,PriceCurrency,TradeDate
AMZN,AMAZON.COM INC,STK,20,185.40,USD,20250210
GOOGL,ALPHABET INC-CL A,STK,15,172.50,USD,20250212
TSLA,TESLA INC,STK,10,240.00,USD,20250215`

export function CsvImportModal({
  isOpen,
  onClose,
  config,
  baseCurrency,
  onImportSuccess,
}: CsvImportModalProps) {
  const [csvText, setCsvText] = useState('')
  const [preview, setPreview] = useState<CsvImportPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')

  if (!isOpen) return null

  const handlePreview = async (textToPreview?: string) => {
    const raw = textToPreview ?? csvText
    if (!raw.trim()) {
      setError('Please paste or upload CSV text.')
      return
    }
    setLoading(true)
    setError(null)
    setSuccessMsg(null)
    try {
      const data = await previewCsvImport(config, raw)
      setPreview(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse CSV.')
    } finally {
      setLoading(false)
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const content = String(event.target?.result ?? '')
      setCsvText(content)
      void handlePreview(content)
    }
    reader.readAsText(file)
  }

  const handleCommit = async () => {
    if (!csvText.trim()) return
    setCommitting(true)
    setError(null)
    try {
      const result = await commitCsvImport(config, csvText, mode)
      setSuccessMsg(
        `Successfully imported ${result.imported_positions} positions, ${result.imported_trades} trades, and ${result.imported_cash_flows} cash flows.`,
      )
      onImportSuccess()
      window.setTimeout(() => {
        onClose()
        setPreview(null)
        setCsvText('')
        setSuccessMsg(null)
      }, 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.')
    } finally {
      setCommitting(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="CSV and Broker Statement Import Wizard"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.65)',
        zIndex: 1100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        style={{
          width: 'min(820px, 96vw)',
          background: 'var(--surface-panel)',
          border: '1px solid rgba(0, 210, 255, 0.35)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.8), 0 0 30px rgba(0, 210, 255, 0.15)',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '1rem 1.4rem',
            borderBottom: '1px solid var(--line)',
            background: 'var(--surface-header)',
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
              Broker Statement & CSV Import Wizard
            </h3>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Auto-detects Interactive Brokers (IBKR), ATLAS standard, or custom broker statements (Base: {baseCurrency})
            </div>
          </div>
          <button
            type="button"
            className="button button--quiet button--mini"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        <div style={{ padding: '1rem 1.25rem', overflowY: 'auto', flex: 1 }}>
          {error && (
            <div
              style={{
                padding: '0.65rem 0.85rem',
                background: 'rgba(218, 30, 40, 0.1)',
                borderLeft: '3px solid var(--negative)',
                marginBottom: '1rem',
                fontSize: '0.85rem',
                color: 'var(--negative)',
              }}
            >
              {error}
            </div>
          )}

          {successMsg && (
            <div
              style={{
                padding: '0.65rem 0.85rem',
                background: 'rgba(36, 161, 72, 0.1)',
                borderLeft: '3px solid var(--positive)',
                marginBottom: '1rem',
                fontSize: '0.85rem',
                color: 'var(--positive)',
              }}
            >
              {successMsg}
            </div>
          )}

          <div style={{ marginBottom: '1rem' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '0.4rem',
              }}
            >
              <label className="field__label" style={{ margin: 0 }}>
                Upload CSV File or Paste Raw Text:
              </label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  className="button button--quiet button--mini"
                  onClick={() => {
                    setCsvText(SAMPLE_ATLAS_CSV)
                    void handlePreview(SAMPLE_ATLAS_CSV)
                  }}
                >
                  Load Sample ATLAS CSV
                </button>
                <button
                  type="button"
                  className="button button--quiet button--mini"
                  onClick={() => {
                    setCsvText(SAMPLE_IBKR_CSV)
                    void handlePreview(SAMPLE_IBKR_CSV)
                  }}
                >
                  Load Sample IBKR CSV
                </button>
              </div>
            </div>

            <input
              type="file"
              accept=".csv,.txt"
              onChange={handleFileUpload}
              style={{
                marginBottom: '0.5rem',
                fontSize: '0.8rem',
                display: 'block',
              }}
            />

            <textarea
              className="input num"
              rows={6}
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              placeholder="Paste comma- or semicolon-separated rows here..."
              style={{
                width: '100%',
                fontFamily: 'monospace',
                fontSize: '0.78rem',
                resize: 'vertical',
              }}
            />
          </div>

          <div
            style={{
              display: 'flex',
              gap: '0.75rem',
              alignItems: 'center',
              marginBottom: '1rem',
            }}
          >
            <button
              type="button"
              className="button button--sm"
              onClick={() => void handlePreview()}
              disabled={loading}
            >
              {loading ? 'Analyzing…' : 'Parse & Preview CSV'}
            </button>
            {preview && (
              <span
                className="num"
                style={{
                  fontSize: '0.75rem',
                  padding: '0.2rem 0.5rem',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                Format: <strong>{preview.detected_format}</strong> · {preview.summary.positions_count} positions · {preview.summary.trades_count} trades
              </span>
            )}
          </div>

          {preview && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {preview.warnings.length > 0 && (
                <div
                  style={{
                    padding: '0.65rem 0.85rem',
                    background: 'rgba(210, 153, 34, 0.1)',
                    borderLeft: '3px solid #d29922',
                    fontSize: '0.8rem',
                  }}
                >
                  <strong>Warnings:</strong>
                  <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
                    {preview.warnings.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.positions.length > 0 && (
                <div>
                  <h4 style={{ margin: '0 0 0.4rem', fontSize: '0.85rem' }}>
                    Positions to Import ({preview.positions.length}):
                  </h4>
                  <div className="grid__scroll" style={{ maxHeight: '180px' }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Ticker</th>
                          <th>Name</th>
                          <th>Class</th>
                          <th>Region</th>
                          <th>CCY</th>
                          <th className="num">Quantity</th>
                          <th className="num">Cost / Unit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.positions.map((p, idx) => (
                          <tr key={idx}>
                            <td className="num">
                              <strong>{p.ticker}</strong>
                            </td>
                            <td>{p.name}</td>
                            <td>{p.asset_class}</td>
                            <td>{p.region}</td>
                            <td className="num">{p.currency}</td>
                            <td className="num">{p.quantity}</td>
                            <td className="num">{formatMoney(p.cost_basis_per_unit)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {preview.trades.length > 0 && (
                <div>
                  <h4 style={{ margin: '0 0 0.4rem', fontSize: '0.85rem' }}>
                    Trades to Record ({preview.trades.length}):
                  </h4>
                  <div className="grid__scroll" style={{ maxHeight: '140px' }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Ticker</th>
                          <th>Side</th>
                          <th className="num">Quantity</th>
                          <th className="num">Price</th>
                          <th>Date</th>
                          <th>Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.trades.map((t, idx) => (
                          <tr key={idx}>
                            <td className="num">
                              <strong>{t.ticker}</strong>
                            </td>
                            <td className={t.order_type === 'BUY' ? 'pos' : 'neg'}>
                              {t.order_type}
                            </td>
                            <td className="num">{t.quantity}</td>
                            <td className="num">{formatMoney(t.price)}</td>
                            <td className="num">{t.executed_at}</td>
                            <td>{t.notes}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {preview.cash_flows.length > 0 && (
                <div>
                  <h4 style={{ margin: '0 0 0.4rem', fontSize: '0.85rem' }}>
                    Cash Flows ({preview.cash_flows.length}):
                  </h4>
                  <div className="grid__scroll" style={{ maxHeight: '120px' }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th className="num">Amount</th>
                          <th>Note</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.cash_flows.map((f, idx) => (
                          <tr key={idx}>
                            <td className="num">{f.occurred_on}</td>
                            <td className="num">{formatMoney(f.amount)}</td>
                            <td>{f.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.85rem 1.25rem',
            borderTop: '1px solid var(--border-subtle)',
            background: 'var(--bg-elevated)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.82rem' }}>
            <span>Import Mode:</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
              <input
                type="radio"
                name="importMode"
                value="merge"
                checked={mode === 'merge'}
                onChange={() => setMode('merge')}
              />
              <span>Merge & Update</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
              <input
                type="radio"
                name="importMode"
                value="replace"
                checked={mode === 'replace'}
                onChange={() => setMode('replace')}
              />
              <span>Replace All</span>
            </label>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              className="button button--quiet button--sm"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button--primary button--sm"
              onClick={() => void handleCommit()}
              disabled={committing || !preview || (preview.positions.length === 0 && preview.trades.length === 0 && preview.cash_flows.length === 0)}
            >
              {committing ? 'Committing…' : 'Commit & Import Data'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
