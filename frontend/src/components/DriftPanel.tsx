/**
 * Allocation drift: how far the portfolio has moved from its targets.
 *
 * A position drifts when its price moves differently from the rest of the
 * book. The position that was supposed to be 10% is now 17% without a single
 * trade, and the portfolio has become something the owner did not choose.
 *
 * The trades shown are the ones that would put it back. The turnover is what
 * that would cost in fees and tax, which is the number that decides whether
 * rebalancing is worth doing at all.
 */

import { formatMoney, formatMoneySigned, formatPercent, formatPercentSigned, signClass } from '../lib/format'
import type { SummaryPayload } from '../lib/types'
import { Panel } from './Panel'

interface DriftPanelProps {
  summary: SummaryPayload
  currency: string
}

export function DriftPanel({ summary, currency }: DriftPanelProps) {
  const drift = summary.drift

  if (!drift.has_targets) {
    return (
      <Panel title="Allocation drift" subtitle="no target weights set">
        <div className="state state--inline">
          <span className="state__kicker">No targets</span>
          <span className="state__title">This portfolio has no target weights</span>
          <p className="state__detail">
            Give a position a target weight in the Holdings view and the dashboard will
            show how far the allocation has drifted from it, and which trades would put
            it back. Targets are optional: a portfolio without them is one that has not
            decided what it is for.
          </p>
        </div>
      </Panel>
    )
  }

  return (
    <Panel
      title="Allocation drift"
      subtitle={`${drift.positions.length} ${
        drift.positions.length === 1 ? 'position' : 'positions'
      } with targets`}
    >
      <div className="drift">
        <div className="drift__figures">
          <div className="drift__figure">
            <span className="drift__label">Total drift</span>
            <span className="num drift__value">{formatPercent(drift.total_drift)}</span>
            <span className="drift__context">half the sum of absolute drifts</span>
          </div>
          <div className="drift__figure">
            <span className="drift__label">Turnover to rebalance</span>
            <span className="num drift__value">
              {formatMoney(drift.turnover)} {currency}
            </span>
            <span className="drift__context">the smaller side of the trades</span>
          </div>
          <div className="drift__figure">
            <span className="drift__label">Targets sum</span>
            <span className="num drift__value">{formatPercent(drift.target_sum)}</span>
            {Math.abs(drift.residual) > 0.0005 ? (
              <span className="drift__context drift__context--warn">
                {formatPercent(drift.residual)} unallocated
              </span>
            ) : null}
          </div>
        </div>

        <table className="drift__table">
          <thead>
            <tr>
              <th scope="col">Position</th>
              <th scope="col" className="tabular-right">Current</th>
              <th scope="col" className="tabular-right">Target</th>
              <th scope="col" className="tabular-right">Drift</th>
              <th scope="col" className="tabular-right">Trade</th>
            </tr>
          </thead>
          <tbody>
            {drift.positions.map((row) => (
              <tr key={row.ticker}>
                <td className="num drift__ticker">{row.ticker}</td>
                <td className="num tabular-right">{formatPercent(row.current_weight, 1)}</td>
                <td className="num tabular-right">{formatPercent(row.target_weight, 1)}</td>
                <td className={`num tabular-right ${signClass(row.drift)}`}>
                  {formatPercentSigned(row.drift, 1)}
                </td>
                <td className={`num tabular-right ${signClass(row.trade_value)}`}>
                  {formatMoneySigned(row.trade_value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="drift__note">
          A positive trade is a purchase and a negative one is a sale, at today&apos;s
          prices. Drift is measured against the target weights, which are the
          owner&apos;s intention, not a recommendation.
        </p>
      </div>
    </Panel>
  )
}
