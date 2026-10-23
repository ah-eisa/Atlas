/**
 * Import window: positions, trades and cash flows from a CSV file or a
 * broker statement.
 *
 * Nothing is written until the preview has been reviewed and Import is
 * pressed. The backend detects the format (ATLAS columns, Interactive
 * Brokers, or a generic broker export) and replays trades in date order.
 */

import { useState, type DragEvent } from 'react'

import { commitCsvImport, type DataConfig, previewCsvImport } from '../lib/api'
import { formatMoney } from '../lib/format'
import type { CsvImportPreview } from '../lib/types'
import { Dialog } from './Dialog'

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

const FORMAT_LABELS: Record<string, string> = {
  atlas_combined: 'An ATLAS file',
  ibkr_statement: 'An Interactive Brokers statement',
  broker_trades: 'A broker trade export',
  generic_positions: 'A list of positions',
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export function CsvImportModal({
  isOpen,
  onClose,
  config,
  baseCurrency,
  onImportSuccess,
}: CsvImportModalProps) {
  const [csvText, setCsvText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [preview, setPreview] = useState<CsvImportPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [dragging, setDragging] = useState(false)

  if (!isOpen) return null

  const handlePreview = async (textToPreview?: string) => {
    const raw = textToPreview ?? csvText
    if (!raw.trim()) {
      setError('Choose a file, drop one here, or paste the rows first.')
      return
    }
    setLoading(true)
    setError(null)
    setSuccessMsg(null)
    try {
      const data = await previewCsvImport(config, raw)
      setPreview(data)
    } catch (err) {
      setPreview(null)
      setError(err instanceof Error ? err.message : 'The file could not be read as CSV.')
    } finally {
      setLoading(false)
    }
  }

  const readFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = (event) => {
      const content = String(event.target?.result ?? '')
      setCsvText(content)
      setFileName(file.name)
      void handlePreview(content)
    }
    reader.readAsText(file)
  }

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) readFile(file)
  }

  const loadSample = (text: string, name: string) => {
    setCsvText(text)
    setFileName(name)
    void handlePreview(text)
  }

  const handleCommit = async () => {
    if (!csvText.trim()) return
    setCommitting(true)
    setError(null)
    try {
      const result = await commitCsvImport(config, csvText, mode)
      setSuccessMsg(
        `Imported ${plural(result.imported_positions, 'position', 'positions')}, ` +
          `${plural(result.imported_trades, 'trade', 'trades')} and ` +
          `${plural(result.imported_cash_flows, 'cash flow', 'cash flows')}.`,
      )
      onImportSuccess()
      window.setTimeout(() => {
        onClose()
        setPreview(null)
        setCsvText('')
        setFileName(null)
        setSuccessMsg(null)
      }, 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nothing was imported. Try again.')
    } finally {
      setCommitting(false)
    }
  }

  const rowsToImport = preview
    ? preview.positions.length + preview.trades.length + preview.cash_flows.length
    : 0

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      size="xl"
      title="Import positions and trades"
      description={`From an ATLAS file, an Interactive Brokers statement or another broker's CSV export. Amounts without a currency are read as ${baseCurrency}.`}
      closeOnBackdrop={!csvText.trim()}
      footer={
        <>
          <div className="dialog__footer-start import__mode">
            <span className="import__mode-label" id="import-mode-label">
              Existing positions
            </span>
            <div className="choice" role="radiogroup" aria-labelledby="import-mode-label">
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'merge'}
                className="choice__option"
                onClick={() => setMode('merge')}
              >
                Keep and add
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'replace'}
                className="choice__option"
                onClick={() => setMode('replace')}
              >
                Replace
              </button>
            </div>
          </div>
          <button type="button" className="button button--quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void handleCommit()}
            disabled={committing || rowsToImport === 0}
          >
            {committing ? 'Importing…' : rowsToImport > 0 ? `Import ${plural(rowsToImport, 'row', 'rows')}` : 'Import'}
          </button>
        </>
      }
    >
      {successMsg && (
        <div className="dialog__notice dialog__notice--success" role="status">
          {successMsg}
        </div>
      )}

      <section className="import__source" aria-label="File to import">
        <label
          className={dragging ? 'dropzone dropzone--active' : 'dropzone'}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <input
            type="file"
            accept=".csv,.txt"
            className="dropzone__input"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) readFile(file)
            }}
          />
          <span className="dropzone__title">
            {fileName ? fileName : 'Choose a CSV file, or drop it here'}
          </span>
          <span className="dropzone__hint">Comma- or semicolon-separated, with a header row.</span>
        </label>

        <div className="import__samples">
          <span>Or try a sample:</span>
          <button
            type="button"
            className="button button--quiet button--sm"
            onClick={() => loadSample(SAMPLE_ATLAS_CSV, 'ATLAS sample')}
          >
            ATLAS sample
          </button>
          <button
            type="button"
            className="button button--quiet button--sm"
            onClick={() => loadSample(SAMPLE_IBKR_CSV, 'Interactive Brokers sample')}
          >
            Interactive Brokers sample
          </button>
        </div>

        <details className="import__paste" open={Boolean(csvText) && !fileName}>
          <summary>Paste rows instead</summary>
          <textarea
            className="input num import__textarea"
            rows={6}
            value={csvText}
            onChange={(e) => {
              setCsvText(e.target.value)
              setFileName(null)
            }}
            placeholder="ticker,quantity,cost_basis_per_unit,acquired"
            spellCheck={false}
          />
          <button
            type="button"
            className="button"
            onClick={() => void handlePreview()}
            disabled={loading || !csvText.trim()}
          >
            {loading ? 'Reading…' : 'Preview'}
          </button>
        </details>
      </section>

      {error && (
        <div className="dialog__error" role="alert">
          {error}
        </div>
      )}

      {loading && !preview && (
        <p className="import__status" role="status">
          Reading the file…
        </p>
      )}

      {preview && (
        <section className="import__preview" aria-label="What will be imported">
          <p className="import__detected">
            {FORMAT_LABELS[preview.detected_format] ?? preview.detected_format} with{' '}
            {plural(preview.summary.positions_count, 'position', 'positions')},{' '}
            {plural(preview.summary.trades_count, 'trade', 'trades')} and{' '}
            {plural(preview.summary.cash_flows_count, 'cash flow', 'cash flows')}.
          </p>

          {preview.warnings.length > 0 && (
            <div className="dialog__notice dialog__notice--warning">
              <strong>
                {plural(preview.warnings.length, 'row needs', 'rows need')} attention
              </strong>
              <ul>
                {preview.warnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {preview.positions.length > 0 && (
            <div className="import__table">
              <h3>Positions</h3>
              <div className="grid__scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Name</th>
                      <th>Class</th>
                      <th>Region</th>
                      <th>Currency</th>
                      <th className="num">Quantity</th>
                      <th className="num">Cost per unit</th>
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
                        <td>{p.currency}</td>
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
            <div className="import__table">
              <h3>Trades, in the order they will be recorded</h3>
              <div className="grid__scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Symbol</th>
                      <th>Side</th>
                      <th className="num">Quantity</th>
                      <th className="num">Price</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.trades.map((t, idx) => (
                      <tr key={idx}>
                        <td className="num">{t.executed_at}</td>
                        <td className="num">
                          <strong>{t.ticker}</strong>
                        </td>
                        <td className={t.order_type === 'BUY' ? 'pos' : 'neg'}>
                          {t.order_type === 'BUY' ? 'Buy' : 'Sell'}
                        </td>
                        <td className="num">{t.quantity}</td>
                        <td className="num">{formatMoney(t.price)}</td>
                        <td>{t.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {preview.cash_flows.length > 0 && (
            <div className="import__table">
              <h3>Cash flows</h3>
              <div className="grid__scroll">
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

          {mode === 'replace' && preview.positions.length > 0 && (
            <div className="dialog__notice dialog__notice--warning">
              Replace removes every position in this portfolio before importing these.
            </div>
          )}
        </section>
      )}
    </Dialog>
  )
}
