/**
 * Oversight: the record of every change, and the statements written on a
 * schedule.
 *
 * The audit trail lists who changed what and when, newest first, filterable
 * by kind of change, with a check that its hash chain is unbroken - an entry
 * edited or removed after it was written shows where. The reports panel sets
 * up daily, weekly or monthly statements, runs one now, and opens what each
 * run wrote.
 */

import { useCallback, useEffect, useState } from 'react'

import { Panel, Segmented } from '../components/Panel'
import {
  createReportSchedule,
  deleteReportSchedule,
  listAudit,
  listReportRuns,
  listReportSchedules,
  openReportRun,
  runReportNow,
  toggleReportSchedule,
  verifyAudit,
  type DataConfig,
} from '../lib/api'
import { formatTimestamp } from '../lib/format'
import type { AuditEntry, AuditVerification, PortfolioState, ReportRun, ReportSchedule } from '../lib/types'

interface OversightViewProps {
  state: PortfolioState
  config: DataConfig
}

type ActionFilter = '' | 'order' | 'position' | 'ledger' | 'mandate' | 'rule' | 'report'

const FILTERS: { value: ActionFilter; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'order', label: 'Orders' },
  { value: 'position', label: 'Positions' },
  { value: 'ledger', label: 'Ledger' },
  { value: 'mandate', label: 'Mandate' },
  { value: 'rule', label: 'Rules' },
  { value: 'report', label: 'Reports' },
]

const ACTION_LABELS: Record<string, string> = {
  'order.place': 'Placed an order',
  'order.delete': 'Deleted an order',
  'position.create': 'Added a position',
  'position.update': 'Edited a position',
  'position.delete': 'Removed a position',
  'position.sleeve': 'Moved a position to a sleeve',
  'positions.replace': 'Imported positions',
  'ledger.create': 'Recorded a ledger entry',
  'ledger.delete': 'Deleted a ledger entry',
  'cash_flow.create': 'Recorded a deposit or withdrawal',
  'cash_flow.delete': 'Deleted a deposit or withdrawal',
  'mandate.benchmark': 'Changed the benchmark policy',
  'mandate.model': 'Changed the model followed',
  'model.create': 'Created a model portfolio',
  'model.update': 'Edited a model portfolio',
  'model.delete': 'Deleted a model portfolio',
  'sleeve.create': 'Added a sleeve',
  'sleeve.update': 'Edited a sleeve',
  'sleeve.delete': 'Deleted a sleeve',
  'rule.create': 'Added a compliance rule',
  'rule.enable': 'Resumed a compliance rule',
  'rule.disable': 'Paused a compliance rule',
  'rule.delete': 'Deleted a compliance rule',
  'report.schedule': 'Scheduled a report',
  'report.unschedule': 'Removed a report schedule',
  'report.enable': 'Resumed a report schedule',
  'report.disable': 'Paused a report schedule',
  'report.run': 'Wrote a statement',
  'settings.base_currency': 'Changed the reporting currency',
  'portfolio.create': 'Created a portfolio',
  'portfolio.delete': 'Deleted a portfolio',
  'portfolio.seed': 'Loaded the demo portfolio',
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** The few details of an entry worth reading at a glance. */
function summarise(entry: AuditEntry): string {
  const detail = entry.detail as Record<string, unknown>
  const after = (detail.after ?? {}) as Record<string, unknown>
  const before = (detail.before ?? {}) as Record<string, unknown>
  const ticker = detail.ticker ?? after.ticker ?? before.ticker
  const parts: string[] = []
  if (ticker) parts.push(String(ticker))
  if (detail.order_type) parts.push(`${String(detail.order_type).toLowerCase()} ${detail.quantity} at ${detail.price}`)
  if (detail.kind) parts.push(String(detail.kind).toLowerCase().replace(/_/g, ' '))
  if (detail.name) parts.push(String(detail.name))
  if (entry.action === 'position.update' && before.quantity !== undefined && after.quantity !== undefined)
    parts.push(`${before.quantity} → ${after.quantity} units`)
  if (detail.status) parts.push(String(detail.status))
  if (typeof detail.after === 'string') parts.push(String(detail.after))
  return parts.join(' · ')
}

export default function OversightView({ state, config }: OversightViewProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [filter, setFilter] = useState<ActionFilter>('')
  const [verification, setVerification] = useState<AuditVerification | null>(null)
  const [schedules, setSchedules] = useState<ReportSchedule[]>([])
  const [runs, setRuns] = useState<ReportRun[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [name, setName] = useState('Monthly statement')
  const [frequency, setFrequency] = useState<ReportSchedule['frequency']>('monthly')
  const [weekday, setWeekday] = useState(0)
  const [monthday, setMonthday] = useState(1)
  const [hour, setHour] = useState(7)

  const isLive = state.source === 'api'

  const loadAudit = useCallback(
    async (more = false) => {
      const page = await listAudit(config, { beforeId: more ? nextBefore : null, action: filter })
      setEntries((current) => (more ? [...current, ...page.entries] : page.entries))
      setNextBefore(page.next_before_id)
    },
    [config, filter, nextBefore],
  )

  const loadReports = useCallback(async () => {
    const [loadedSchedules, loadedRuns] = await Promise.all([listReportSchedules(config), listReportRuns(config)])
    setSchedules(loadedSchedules)
    setRuns(loadedRuns)
  }, [config])

  useEffect(() => {
    if (!isLive) return
    listAudit(config, { action: filter })
      .then((page) => {
        setEntries(page.entries)
        setNextBefore(page.next_before_id)
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [config, filter, isLive])

  useEffect(() => {
    if (!isLive) return
    loadReports().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [isLive, loadReports])

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      await Promise.all([loadReports(), loadAudit()])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!isLive) {
    return (
      <main className="app__main">
        <Panel title="Oversight" subtitle="Snapshot mode">
          <div className="state state--inline">
            <span className="state__kicker">Demo snapshot mode</span>
            <span className="state__title">The audit trail and reports are available in Live API mode</span>
            <p className="state__detail">
              Every change made through the live API is recorded, and statements can be written on a schedule.
            </p>
          </div>
        </Panel>
      </main>
    )
  }

  const schedule = (event: React.FormEvent) => {
    event.preventDefault()
    void act(() => createReportSchedule(config, { name: name.trim() || 'Statement', frequency, weekday, monthday, hour }))
  }

  return (
    <main className="app__main">
      {error && (
        <div className="banner banner--error" role="alert">
          <span className="banner__label">Not done</span>
          <span className="banner__message">{error}</span>
        </div>
      )}

      <Panel
        title="Audit trail"
        subtitle="every change, who made it and when; it cannot be edited"
        actions={
          <div className="ledger__actions">
            {verification ? (
              <span
                className={`pill-badge ${verification.valid ? 'pill-badge--pos' : 'pill-badge--neg'}`}
                title={verification.reason ?? undefined}
              >
                {verification.valid
                  ? `Chain intact · ${verification.entries} entries`
                  : `Broken at entry ${verification.broken_at}`}
              </span>
            ) : null}
            <button
              type="button"
              className="button button--sm"
              onClick={() =>
                void verifyAudit(config)
                  .then(setVerification)
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
              }
            >
              Verify the chain
            </button>
          </div>
        }
      >
        <div className="holdings-toolbar">
          <Segmented options={FILTERS} value={filter} onChange={setFilter} ariaLabel="Kind of change" />
        </div>
        <div className="grid__scroll">
          <table className="grid">
            <thead>
              <tr>
                <th className="grid__th">When</th>
                <th className="grid__th">Who</th>
                <th className="grid__th">What</th>
                <th className="grid__th">Detail</th>
                <th className="grid__th grid__th--right">Entry</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="grid__td ledger__empty">
                    Nothing recorded yet.
                  </td>
                </tr>
              ) : (
                entries.map((entry) => (
                  <tr key={entry.id} className="grid__row">
                    <td className="grid__td num">{formatTimestamp(entry.at)}</td>
                    <td className="grid__td num">{entry.actor}</td>
                    <td className="grid__td">{ACTION_LABELS[entry.action] ?? entry.action}</td>
                    <td className="grid__td num muted">{summarise(entry)}</td>
                    <td className="grid__td grid__td--right num muted" title={`hash ${entry.hash}`}>
                      #{entry.id}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {nextBefore ? (
          <div className="panel-note">
            <button type="button" className="button button--sm" onClick={() => void loadAudit(true)}>
              Show older entries
            </button>
          </div>
        ) : null}
      </Panel>

      <div className="row row--split">
        <Panel title="Scheduled reports" subtitle="a statement written on a schedule, in the server's local time">
          <div className="mandate-panel">
            <ul className="mandate-list">
              {schedules.length === 0 ? <li className="ledger__empty">No reports scheduled.</li> : null}
              {schedules.map((item) => (
                <li key={item.id} className={`mandate-list__item${item.enabled ? '' : ' mandate-list__item--paused'}`}>
                  <span className="mandate-list__name">{item.name}</span>
                  <span className="muted">
                    {item.description}
                    {item.enabled ? ` · next ${formatTimestamp(item.next_run_at)}` : ' · paused'}
                  </span>
                  <span className="mandate-list__actions">
                    <button
                      type="button"
                      className="button button--quiet button--mini"
                      disabled={busy}
                      onClick={() => void act(() => runReportNow(config, item.id))}
                    >
                      Run now
                    </button>
                    <button
                      type="button"
                      className="button button--quiet button--mini"
                      disabled={busy}
                      onClick={() => void act(() => toggleReportSchedule(config, item.id, !item.enabled))}
                    >
                      {item.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button
                      type="button"
                      className="button button--danger-text button--mini"
                      aria-label={`Remove the schedule ${item.name}`}
                      disabled={busy}
                      onClick={() => void act(() => deleteReportSchedule(config, item.id))}
                    >
                      &times;
                    </button>
                  </span>
                </li>
              ))}
            </ul>

            <form className="mandate-form" onSubmit={schedule}>
              <label className="field">
                <span className="field__label">Name</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
              </label>
              <label className="field">
                <span className="field__label">How often</span>
                <select
                  className="input"
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value as ReportSchedule['frequency'])}
                  disabled={busy}
                >
                  <option value="daily">Every day</option>
                  <option value="weekly">Every week</option>
                  <option value="monthly">Every month</option>
                </select>
              </label>
              {frequency === 'weekly' ? (
                <label className="field">
                  <span className="field__label">On</span>
                  <select className="input" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} disabled={busy}>
                    {WEEKDAYS.map((day, index) => (
                      <option key={day} value={index}>
                        {day}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {frequency === 'monthly' ? (
                <label className="field">
                  <span className="field__label">Day of the month</span>
                  <input
                    className="input num"
                    type="number"
                    min={1}
                    max={31}
                    value={monthday}
                    onChange={(e) => setMonthday(Number(e.target.value))}
                    disabled={busy}
                  />
                </label>
              ) : null}
              <label className="field">
                <span className="field__label">At (hour)</span>
                <input
                  className="input num"
                  type="number"
                  min={0}
                  max={23}
                  value={hour}
                  onChange={(e) => setHour(Number(e.target.value))}
                  disabled={busy}
                />
              </label>
              <button type="submit" className="button button--primary" disabled={busy}>
                Schedule
              </button>
            </form>
          </div>
        </Panel>

        <Panel
          title="Statements written"
          subtitle="newest first"
          actions={
            <button type="button" className="button button--sm" disabled={busy} onClick={() => void act(() => runReportNow(config))}>
              {busy ? 'Writing…' : 'Write one now'}
            </button>
          }
        >
          <ul className="mandate-list mandate-panel">
            {runs.length === 0 ? <li className="ledger__empty">No statements yet.</li> : null}
            {runs.map((run) => (
              <li key={run.id} className="mandate-list__item">
                <span className="mandate-list__name">{run.schedule_name}</span>
                <span className={run.status === 'failed' ? 'neg' : 'muted'}>
                  {formatTimestamp(run.started_at)} · {run.status === 'done' ? 'written' : run.status}
                  {run.error ? ` · ${run.error}` : ''}
                </span>
                <span className="mandate-list__actions">
                  {run.status === 'done' ? (
                    <button
                      type="button"
                      className="button button--quiet button--mini"
                      onClick={() =>
                        void openReportRun(config, run.id).catch((cause: unknown) =>
                          setError(cause instanceof Error ? cause.message : String(cause)),
                        )
                      }
                    >
                      Open
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </main>
  )
}
