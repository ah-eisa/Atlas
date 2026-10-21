/**
 * Where the active return came from.
 *
 * The active return is what the portfolio earned above its benchmark. This
 * says which positions paid for it and which parts of the book produced it -
 * the question every attribution table exists to answer.
 *
 * The decomposition is per position, against a single index: the weight the
 * position actually had each day times its return less the benchmark's. The
 * difference between the explained part and the headline active return is
 * compounding and cash flows, and it is shown rather than buried.
 */

import { formatPercent, formatPercentSigned, signClass } from '../lib/format'
import type { SummaryPayload } from '../lib/types'
import { Panel } from './Panel'

interface AttributionPanelProps {
  summary: SummaryPayload
}

interface Bucket {
  key: string
  contribution_pct: number
}

export function AttributionPanel({ summary }: AttributionPanelProps) {
  const attribution = summary.attribution
  const positions = attribution.positions.slice(0, 8)
  const largest = positions.reduce(
    (max, row) => Math.max(max, Math.abs(row.contribution_pct)),
    0,
  )

  const bucketRows = (buckets: Bucket[]) =>
    buckets.map((bucket) => (
      <tr key={bucket.key}>
        <td className="attribution-bucket__key">{bucket.key}</td>
        <td className={`num tabular-right ${signClass(bucket.contribution_pct)}`}>
          {formatPercentSigned(bucket.contribution_pct, 1)}
        </td>
      </tr>
    ))

  return (
    <Panel
      title="Active return attribution"
      subtitle={`${formatPercentSigned(attribution.active_return_pct)} above the benchmark`}
    >
      <div className="attribution-bucket">
        <div className="attribution-bucket__columns">
          <div className="attribution-bucket__column">
            <table className="attribution-bucket__table">
              <thead>
                <tr>
                  <th scope="col">Position</th>
                  <th scope="col" className="tabular-right">Weight</th>
                  <th scope="col" className="tabular-right">Contribution</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((row) => (
                  <tr key={row.ticker}>
                    <td className="num attribution-bucket__ticker">{row.ticker}</td>
                    <td className="num tabular-right">{formatPercent(row.weight, 1)}</td>
                    <td className="attribution-bucket__bar-cell">
                      <span
                        className={`attribution-bucket__bar ${
                          row.contribution_pct < 0
                            ? 'attribution-bucket__bar--negative'
                            : ''
                        }`}
                        style={{
                          width: `${
                            largest > 0
                              ? (Math.abs(row.contribution_pct) / largest) * 100
                              : 0
                          }%`,
                        }}
                        aria-hidden="true"
                      />
                      <span className={`num tabular-right ${signClass(row.contribution_pct)}`}>
                        {formatPercentSigned(row.contribution_pct, 1)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="attribution-bucket__column">
            <table className="attribution-bucket__table">
              <thead>
                <tr>
                  <th scope="col">Region</th>
                  <th scope="col" className="tabular-right">Contribution</th>
                </tr>
              </thead>
              <tbody>{bucketRows(attribution.by_region)}</tbody>
            </table>
            <table className="attribution-bucket__table">
              <thead>
                <tr>
                  <th scope="col">Asset class</th>
                  <th scope="col" className="tabular-right">Contribution</th>
                </tr>
              </thead>
              <tbody>{bucketRows(attribution.by_asset_class)}</tbody>
            </table>
          </div>
        </div>

        <p className="attribution-bucket__note">
          Each position is credited with its own return above the benchmark, weighted by
          the share of the portfolio it held that day. The residual of{' '}
          {formatPercentSigned(attribution.residual, 1)} is compounding and the effect of
          contributions, not a missing position.
        </p>
      </div>
    </Panel>
  )
}
