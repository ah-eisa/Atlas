/**
 * The mandate: what the portfolio is held to.
 *
 * Top to bottom: whether it is inside its limits right now (every compliance
 * rule, its figure against its limit, and what is responsible for a breach),
 * the benchmark it is measured against, the model it follows, and the sleeves
 * it is divided into. Changing the benchmark, the model or the sleeves
 * rebuilds the analytics; rules are checked against them as they are.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { Panel } from '../components/Panel'
import {
  assignSleeve,
  createComplianceRule,
  deleteComplianceRule,
  deleteModel,
  deleteSleeve,
  getCompliance,
  getMandate,
  saveModel,
  saveSleeve,
  setBenchmarkPolicy,
  setPortfolioModel,
  toggleComplianceRule,
  type DataConfig,
} from '../lib/api'
import { formatMoney, formatPercent, formatPercentSigned, signClass } from '../lib/format'
import type {
  ComplianceReport,
  ComplianceResult,
  ComplianceStatus,
  Mandate,
  ModelPortfolio,
  PortfolioState,
} from '../lib/types'

interface MandateViewProps {
  state: PortfolioState
  config: DataConfig
  onReload: () => void
}

const STATUS_LABELS: Record<ComplianceStatus, string> = {
  pass: 'Within its limits',
  warning: 'Close to a limit',
  breach: 'A limit is breached',
  unknown: 'Not fully measurable yet',
}

const STATUS_PILL: Record<ComplianceStatus, string> = {
  pass: 'pill-badge--pos',
  warning: 'pill-badge--warning',
  breach: 'pill-badge--neg',
  unknown: 'pill-badge--warning',
}

function parsePercent(value: string): number | null {
  const number = Number.parseFloat(value.replace(',', '.').replace('%', ''))
  return Number.isFinite(number) ? number / 100 : null
}

function figure(result: ComplianceResult, value: number | null): string {
  if (value === null) return '—'
  if (result.unit === 'weight') return formatPercent(value, 1)
  if (result.unit === 'count') return String(Math.round(value))
  return result.offenders.length ? result.offenders.join(', ') : 'none held'
}

/** Rows of a weights editor: an instrument and its share, entered in percent. */
interface WeightRow {
  symbol: string
  percent: string
}

function WeightsEditor({
  rows,
  onChange,
  placeholder,
}: {
  rows: WeightRow[]
  onChange: (rows: WeightRow[]) => void
  placeholder: string
}) {
  const total = rows.reduce((sum, row) => sum + (parsePercent(row.percent) ?? 0), 0)
  return (
    <div className="weights-editor">
      {rows.map((row, index) => (
        <div key={index} className="weights-editor__row">
          <input
            className="input num"
            aria-label="Symbol"
            placeholder={placeholder}
            value={row.symbol}
            onChange={(e) => onChange(rows.map((r, i) => (i === index ? { ...r, symbol: e.target.value.toUpperCase() } : r)))}
          />
          <input
            className="input num"
            aria-label="Weight in percent"
            inputMode="decimal"
            placeholder="%"
            value={row.percent}
            onChange={(e) => onChange(rows.map((r, i) => (i === index ? { ...r, percent: e.target.value } : r)))}
          />
          <button
            type="button"
            className="button button--quiet button--mini"
            aria-label="Remove this row"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            &times;
          </button>
        </div>
      ))}
      <div className="weights-editor__foot">
        <button type="button" className="button button--quiet button--sm" onClick={() => onChange([...rows, { symbol: '', percent: '' }])}>
          Add a row
        </button>
        <span className={`num ${Math.abs(total - 1) < 0.005 ? 'pos' : 'muted'}`}>Total {formatPercent(total, 1)}</span>
      </div>
    </div>
  )
}

export default function MandateView({ state, config, onReload }: MandateViewProps) {
  const [mandate, setMandate] = useState<Mandate | null>(null)
  const [report, setReport] = useState<ComplianceReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Rule form.
  const [ruleKind, setRuleKind] = useState('max_position_weight')
  const [ruleSubject, setRuleSubject] = useState('')
  const [ruleLimit, setRuleLimit] = useState('')
  const [ruleSeverity, setRuleSeverity] = useState<'breach' | 'warning'>('breach')

  // Benchmark form.
  const [policyName, setPolicyName] = useState('')
  const [policyRebalance, setPolicyRebalance] = useState<'daily' | 'monthly'>('monthly')
  const [policyRows, setPolicyRows] = useState<WeightRow[]>([])

  // Model form.
  const [editingModel, setEditingModel] = useState<ModelPortfolio | 'new' | null>(null)
  const [modelName, setModelName] = useState('')
  const [modelRows, setModelRows] = useState<WeightRow[]>([])

  // Sleeve form.
  const [sleeveName, setSleeveName] = useState('')
  const [sleeveTarget, setSleeveTarget] = useState('')

  const isLive = state.source === 'api'
  const currency = state.baseCurrency || 'USD'
  const sleeveSummary = state.analytics?.summary?.sleeves
  const drift = state.analytics?.summary?.drift

  const load = useCallback(async () => {
    if (!isLive) return
    try {
      const loaded = await getMandate(config)
      setMandate(loaded)
      const policy = loaded.benchmark_policy
      setPolicyName(policy?.name ?? '')
      setPolicyRebalance(policy?.rebalance ?? 'monthly')
      setPolicyRows(
        policy
          ? policy.components.map((c) => ({ symbol: c.symbol, percent: String(Math.round(c.weight * 1000) / 10) }))
          : [
              { symbol: '', percent: '' },
              { symbol: '', percent: '' },
            ],
      )
      try {
        setReport(await getCompliance(config))
      } catch {
        // Without analytics (an empty portfolio) the rules cannot be checked.
        setReport(null)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [config, isLive])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (work: () => Promise<unknown>, rebuilds = true) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      await load()
      if (rebuilds) onReload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const kind = mandate?.rule_kinds.find((k) => k.kind === ruleKind)
  const followed = mandate?.models.find((m) => m.id === mandate.model_id) ?? null
  const ruleOf = useMemo(() => new Map((mandate?.rules ?? []).map((rule) => [rule.id, rule])), [mandate])

  if (!isLive) {
    return (
      <main className="app__main">
        <Panel title="Mandate" subtitle="Snapshot mode">
          <div className="state state--inline">
            <span className="state__kicker">Demo snapshot mode</span>
            <span className="state__title">The mandate is available in Live API mode</span>
            <p className="state__detail">
              Switch to Live API mode to set a benchmark policy, follow a model portfolio, divide the portfolio into
              sleeves and set the limits it must stay within.
            </p>
          </div>
        </Panel>
      </main>
    )
  }

  const addRule = (event: React.FormEvent) => {
    event.preventDefault()
    if (!kind) return
    const limit = kind.unit === 'weight' ? parsePercent(ruleLimit) : kind.unit === 'count' ? Number(ruleLimit) : null
    void act(
      () =>
        createComplianceRule(config, {
          kind: ruleKind,
          subject: ruleSubject.trim() || null,
          limit,
          severity: ruleSeverity,
        }).then(() => {
          setRuleSubject('')
          setRuleLimit('')
        }),
      false,
    )
  }

  const savePolicy = (event: React.FormEvent) => {
    event.preventDefault()
    const components = policyRows
      .filter((row) => row.symbol.trim() && (parsePercent(row.percent) ?? 0) > 0)
      .map((row) => ({ symbol: row.symbol.trim(), weight: parsePercent(row.percent) ?? 0 }))
    void act(() => setBenchmarkPolicy(config, { name: policyName.trim(), rebalance: policyRebalance, components }))
  }

  const startModel = (model: ModelPortfolio | 'new') => {
    setEditingModel(model)
    setModelName(model === 'new' ? '' : model.name)
    setModelRows(
      model === 'new'
        ? [{ symbol: '', percent: '' }]
        : model.weights.map((w) => ({ symbol: w.ticker, percent: String(Math.round(w.weight * 1000) / 10) })),
    )
  }

  const submitModel = (event: React.FormEvent) => {
    event.preventDefault()
    const weights = modelRows
      .filter((row) => row.symbol.trim() && (parsePercent(row.percent) ?? 0) > 0)
      .map((row) => ({ ticker: row.symbol.trim(), weight: parsePercent(row.percent) ?? 0 }))
    const id = editingModel !== 'new' && editingModel ? editingModel.id : undefined
    void act(() => saveModel(config, { name: modelName.trim(), weights }, id).then(() => setEditingModel(null)))
  }

  const addSleeve = (event: React.FormEvent) => {
    event.preventDefault()
    void act(() =>
      saveSleeve(config, { name: sleeveName.trim(), target_weight: sleeveTarget ? parsePercent(sleeveTarget) : null }).then(
        () => {
          setSleeveName('')
          setSleeveTarget('')
        },
      ),
    )
  }

  return (
    <main className="app__main">
      {error && (
        <div className="banner banner--error" role="alert">
          <span className="banner__label">Not saved</span>
          <span className="banner__message">{error}</span>
        </div>
      )}

      <Panel
        title="Compliance"
        subtitle={
          report
            ? `${report.checked} rules checked${report.as_of ? ` on prices as of ${report.as_of}` : ''}`
            : 'the limits the portfolio must stay within'
        }
        actions={
          report ? (
            <span className={`pill-badge ${STATUS_PILL[report.status]}`}>{STATUS_LABELS[report.status]}</span>
          ) : undefined
        }
      >
        <div className="compliance">
          {report && report.results.length > 0 ? (
            report.results.map((result) => {
              const rule = result.rule_id !== null ? ruleOf.get(result.rule_id) : undefined
              const share =
                result.unit === 'weight' && result.limit && result.actual !== null
                  ? Math.min(100, (result.actual / result.limit) * 100)
                  : null
              return (
                <div key={result.rule_id ?? result.label} className={`compliance__row compliance__row--${result.status}`}>
                  <div className="compliance__what">
                    <span className="compliance__label">{result.label}</span>
                    <span className="compliance__limit num">
                      {result.unit === 'list'
                        ? `may not hold ${result.subject?.split(',').join(', ')}`
                        : `${result.kind.startsWith('min') ? 'at least' : 'at most'} ${figure(result, result.limit)}`}
                      {result.severity === 'warning' ? ' · soft limit' : ''}
                    </span>
                  </div>
                  <div className="compliance__figure">
                    <span className="num">{figure(result, result.actual)}</span>
                    {share !== null ? (
                      <span className="compliance__track" aria-hidden="true">
                        <span className="compliance__bar" style={{ width: `${share}%` }} />
                      </span>
                    ) : null}
                  </div>
                  <span className={`pill-badge ${STATUS_PILL[result.status]}`}>{result.status}</span>
                  <div className="compliance__actions">
                    {rule ? (
                      <>
                        <button
                          type="button"
                          className="button button--quiet button--mini"
                          disabled={busy}
                          onClick={() => void act(() => toggleComplianceRule(config, rule.id, !rule.enabled), false)}
                        >
                          {rule.enabled ? 'Pause' : 'Resume'}
                        </button>
                        <button
                          type="button"
                          className="button button--danger-text button--mini"
                          disabled={busy}
                          aria-label={`Delete the rule ${result.label}`}
                          onClick={() => void act(() => deleteComplianceRule(config, rule.id), false)}
                        >
                          &times;
                        </button>
                      </>
                    ) : null}
                  </div>
                  {result.offenders.length > 0 && result.unit !== 'list' ? (
                    <span className="compliance__offenders">Responsible: {result.offenders.join(', ')}</span>
                  ) : null}
                  {result.detail ? <span className="compliance__offenders">{result.detail}</span> : null}
                </div>
              )
            })
          ) : (
            <p className="ledger__empty">No rules yet. Add the first limit below.</p>
          )}
          {(mandate?.rules ?? [])
            .filter((rule) => !rule.enabled)
            .map((rule) => (
              <div key={rule.id} className="compliance__row compliance__row--paused">
                <div className="compliance__what">
                  <span className="compliance__label">
                    {mandate?.rule_kinds.find((k) => k.kind === rule.kind)?.label ?? rule.kind}
                    {rule.subject ? `: ${rule.subject}` : ''}
                  </span>
                  <span className="compliance__limit">Paused</span>
                </div>
                <span />
                <span />
                <div className="compliance__actions">
                  <button
                    type="button"
                    className="button button--quiet button--mini"
                    disabled={busy}
                    onClick={() => void act(() => toggleComplianceRule(config, rule.id, true), false)}
                  >
                    Resume
                  </button>
                </div>
              </div>
            ))}
        </div>

        <form className="mandate-form" onSubmit={addRule}>
          <label className="field">
            <span className="field__label">Limit</span>
            <select className="input" value={ruleKind} onChange={(e) => setRuleKind(e.target.value)} disabled={busy}>
              {(mandate?.rule_kinds ?? []).map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.direction === 'min' ? 'At least: ' : k.direction === 'max' ? 'At most: ' : ''}
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          {kind?.needs_subject ? (
            <label className="field">
              <span className="field__label">
                {kind.unit === 'list' ? 'Symbols, separated by commas' : 'Applies to'}
              </span>
              <input
                className="input"
                value={ruleSubject}
                onChange={(e) => setRuleSubject(e.target.value)}
                placeholder={
                  kind.kind.includes('class') ? 'Stock, ETF, Crypto…' : kind.kind.includes('region') ? 'US, Europe…' : kind.kind.includes('currency') ? 'USD' : 'TSLA, GME'
                }
                disabled={busy}
              />
            </label>
          ) : null}
          {kind && kind.unit !== 'list' ? (
            <label className="field">
              <span className="field__label">{kind.unit === 'count' ? 'Number' : 'Limit (%)'}</span>
              <input
                className="input num"
                inputMode="decimal"
                value={ruleLimit}
                onChange={(e) => setRuleLimit(e.target.value)}
                placeholder={kind.unit === 'count' ? '10' : '10'}
                disabled={busy}
              />
            </label>
          ) : null}
          <label className="field">
            <span className="field__label">When passed</span>
            <select
              className="input"
              value={ruleSeverity}
              onChange={(e) => setRuleSeverity(e.target.value as 'breach' | 'warning')}
              disabled={busy}
            >
              <option value="breach">A breach</option>
              <option value="warning">A warning only</option>
            </select>
          </label>
          <button type="submit" className="button button--primary" disabled={busy}>
            Add the rule
          </button>
        </form>
      </Panel>

      <div className="row row--split">
        <Panel
          title="Benchmark policy"
          subtitle={
            mandate?.benchmark_policy
              ? `measured against ${mandate.benchmark_policy.name}`
              : `measured against ${mandate?.default_benchmark.name ?? 'the configured index'}`
          }
        >
          <form className="mandate-panel" onSubmit={savePolicy}>
            <p className="field__hint">
              A blend of indices or funds, measured with dividends reinvested. It replaces the configured benchmark in
              every comparison: beta, alpha, tracking error and the performance chart.
            </p>
            <label className="field">
              <span className="field__label">Name (optional)</span>
              <input
                className="input"
                value={policyName}
                onChange={(e) => setPolicyName(e.target.value)}
                placeholder="Global 60/40"
                disabled={busy}
              />
            </label>
            <WeightsEditor rows={policyRows} onChange={setPolicyRows} placeholder="ACWI, AGG, ^SP500TR" />
            <label className="field">
              <span className="field__label">Rebalanced</span>
              <select
                className="input"
                value={policyRebalance}
                onChange={(e) => setPolicyRebalance(e.target.value as 'daily' | 'monthly')}
                disabled={busy}
              >
                <option value="monthly">Monthly: the weights drift inside a month</option>
                <option value="daily">Daily: the weights hold every day</option>
              </select>
            </label>
            <div className="mandate-panel__actions">
              {mandate?.benchmark_policy ? (
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={busy}
                  onClick={() => void act(() => setBenchmarkPolicy(config, null))}
                >
                  Use {mandate.default_benchmark.name} again
                </button>
              ) : null}
              <button type="submit" className="button button--primary" disabled={busy}>
                Save the policy
              </button>
            </div>
          </form>
        </Panel>

        <Panel
          title="Model portfolio"
          subtitle={followed ? `following ${followed.name}` : 'targets from the positions themselves'}
        >
          <div className="mandate-panel">
            <label className="field">
              <span className="field__label">This portfolio follows</span>
              <select
                className="input"
                value={mandate?.model_id ?? ''}
                disabled={busy}
                onChange={(e) =>
                  void act(() => setPortfolioModel(config, e.target.value ? Number(e.target.value) : null))
                }
              >
                <option value="">No model: each position's own target</option>
                {(mandate?.models ?? []).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>

            {drift?.has_targets && drift.source === 'model' ? (
              <p className="field__hint">
                {formatPercent(drift.total_drift, 1)} away from the model; rebalancing would trade{' '}
                {formatMoney(drift.turnover)} {currency}.
              </p>
            ) : null}

            <ul className="mandate-list">
              {(mandate?.models ?? []).map((model) => (
                <li key={model.id} className="mandate-list__item">
                  <span className="mandate-list__name">{model.name}</span>
                  <span className="num muted">
                    {model.weights
                      .slice(0, 4)
                      .map((w) => `${w.ticker} ${formatPercent(w.weight, 0)}`)
                      .join(' · ')}
                    {model.weights.length > 4 ? ` · +${model.weights.length - 4}` : ''}
                  </span>
                  <span className="mandate-list__actions">
                    <button type="button" className="button button--quiet button--mini" onClick={() => startModel(model)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="button button--danger-text button--mini"
                      aria-label={`Delete the model ${model.name}`}
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`Delete the model ${model.name}? Portfolios that follow it go back to their own targets.`))
                          void act(() => deleteModel(config, model.id))
                      }}
                    >
                      &times;
                    </button>
                  </span>
                </li>
              ))}
            </ul>

            {editingModel ? (
              <form className="mandate-subform" onSubmit={submitModel}>
                <label className="field">
                  <span className="field__label">Model name</span>
                  <input className="input" value={modelName} onChange={(e) => setModelName(e.target.value)} disabled={busy} />
                </label>
                <WeightsEditor rows={modelRows} onChange={setModelRows} placeholder="VWCE.DE" />
                <p className="field__hint">Weights may add up to less than 100%: the rest is cash.</p>
                <div className="mandate-panel__actions">
                  <button type="button" className="button button--quiet" onClick={() => setEditingModel(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="button button--primary" disabled={busy}>
                    Save the model
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" className="button" onClick={() => startModel('new')}>
                New model portfolio
              </button>
            )}
          </div>
        </Panel>
      </div>

      <Panel title="Sleeves" subtitle="the parts of the portfolio, each with its own target">
        {sleeveSummary?.has_sleeves ? (
          <div className="grid__scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th className="grid__th">Sleeve</th>
                  <th className="grid__th grid__th--right">Value ({currency})</th>
                  <th className="grid__th grid__th--right">Weight</th>
                  <th className="grid__th grid__th--right">Target</th>
                  <th className="grid__th grid__th--right">Drift</th>
                  <th className="grid__th grid__th--right">This year</th>
                  <th className="grid__th grid__th--right">Since the start</th>
                  <th className="grid__th">Positions</th>
                </tr>
              </thead>
              <tbody>
                {sleeveSummary.sleeves.map((row) => (
                  <tr key={row.name} className="grid__row">
                    <td className="grid__td grid__strong">{row.name}</td>
                    <td className="grid__td grid__td--right num">{formatMoney(row.value)}</td>
                    <td className="grid__td grid__td--right num">{formatPercent(row.weight, 1)}</td>
                    <td className="grid__td grid__td--right num">{row.target_weight !== null ? formatPercent(row.target_weight, 1) : '—'}</td>
                    <td className={`grid__td grid__td--right num ${signClass(row.drift)}`}>
                      {row.drift !== null ? formatPercentSigned(row.drift, 1) : '—'}
                    </td>
                    <td className={`grid__td grid__td--right num ${signClass(row.return_ytd_pct)}`}>
                      {formatPercentSigned(row.return_ytd_pct, 1)}
                    </td>
                    <td className={`grid__td grid__td--right num ${signClass(row.return_all_pct)}`}>
                      {formatPercentSigned(row.return_all_pct, 1)}
                    </td>
                    <td className="grid__td num muted">{row.positions.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="mandate-panel">
          <div className="sleeve-assign">
            {state.positions.map((position) => (
                <label key={position.id} className="sleeve-assign__row">
                  <span className="num grid__ticker">{position.ticker}</span>
                  <select
                    className="input"
                    value={position.sleeve_id ?? ''}
                    disabled={busy || !mandate?.sleeves.length}
                    onChange={(e) =>
                      void act(() => assignSleeve(config, position.id, e.target.value ? Number(e.target.value) : null))
                    }
                  >
                    <option value="">No sleeve</option>
                    {(mandate?.sleeves ?? []).map((sleeve) => (
                      <option key={sleeve.id} value={sleeve.id}>
                        {sleeve.name}
                      </option>
                    ))}
                  </select>
                </label>
            ))}
          </div>

          <ul className="mandate-list">
            {(mandate?.sleeves ?? []).map((sleeve) => (
              <li key={sleeve.id} className="mandate-list__item">
                <span className="mandate-list__name">{sleeve.name}</span>
                <span className="num muted">
                  {sleeve.target_weight !== null ? `target ${formatPercent(sleeve.target_weight, 1)}` : 'no target'} ·{' '}
                  {sleeve.positions} {sleeve.positions === 1 ? 'position' : 'positions'}
                </span>
                <span className="mandate-list__actions">
                  <button
                    type="button"
                    className="button button--danger-text button--mini"
                    aria-label={`Delete the sleeve ${sleeve.name}`}
                    disabled={busy}
                    onClick={() => void act(() => deleteSleeve(config, sleeve.id))}
                  >
                    &times;
                  </button>
                </span>
              </li>
            ))}
          </ul>

          <form className="mandate-form" onSubmit={addSleeve}>
            <label className="field">
              <span className="field__label">New sleeve</span>
              <input
                className="input"
                value={sleeveName}
                onChange={(e) => setSleeveName(e.target.value)}
                placeholder="Core, Satellite, Income"
                disabled={busy}
              />
            </label>
            <label className="field">
              <span className="field__label">Target (%) optional</span>
              <input
                className="input num"
                inputMode="decimal"
                value={sleeveTarget}
                onChange={(e) => setSleeveTarget(e.target.value)}
                placeholder="60"
                disabled={busy}
              />
            </label>
            <button type="submit" className="button" disabled={busy || !sleeveName.trim()}>
              Add the sleeve
            </button>
          </form>
        </div>
      </Panel>
    </main>
  )
}
