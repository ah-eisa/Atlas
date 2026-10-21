/**
 * Monthly return heatmap.
 *
 * A monthly grid makes the shape of the year legible in a way daily returns
 * never can: clusters of losses, the length of a drawdown, and whether a good
 * month merely recovered a bad one. Magnitude is encoded by a small discrete
 * scale rather than a continuous gradient, so adjacent cells stay comparable
 * and the palette remains inspectable.
 */

import { EM_DASH, formatPercent, formatPercentSigned, signClass } from '../lib/format'
import type { ReturnsPayload } from '../lib/types'
import { Panel } from './Panel'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

interface MonthlyReturnsPanelProps {
  returns: ReturnsPayload
}

function heatLevel(value: number, maxAbs: number): number {
  if (maxAbs <= 0) return 1
  const share = Math.abs(value) / maxAbs
  if (share <= 0.25) return 1
  if (share <= 0.5) return 2
  if (share <= 0.75) return 3
  return 4
}

export function MonthlyReturnsPanel({ returns }: MonthlyReturnsPanelProps) {
  const monthly = returns.monthly_pct
  const years = [...new Set(monthly.map((item) => item.month.slice(0, 4)))].sort()
  const lookup = new Map(monthly.map((item) => [item.month, item.pct]))
  const yearly = new Map(returns.yearly_pct.map((item) => [item.year, item.pct]))
  const maxAbs = monthly.reduce(
    (max, item) => (item.pct === null ? max : Math.max(max, Math.abs(item.pct))),
    0,
  )

  return (
    <Panel
      title="Monthly returns"
      subtitle="time-weighted · contributions excluded"
      className="monthly-panel"
    >
      <div className="monthly__scroll">
        <table className="monthly">
          <caption className="sr-only">
            Monthly time-weighted portfolio returns by year, with full-year returns in the
            final column.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="monthly__year-head" />
              {MONTHS.map((month) => (
                <th key={month} scope="col" className="monthly__head">
                  {month}
                </th>
              ))}
              <th scope="col" className="monthly__head monthly__head--year">
                Year
              </th>
            </tr>
          </thead>
          <tbody>
            {years.map((year) => (
              <tr key={year}>
                <th scope="row" className="monthly__year num">
                  {year}
                </th>
                {MONTHS.map((_, index) => {
                  const key = `${year}-${String(index + 1).padStart(2, '0')}`
                  const value = lookup.get(key)
                  if (value === undefined || value === null) {
                    return (
                      <td key={key} className="monthly__cell">
                        <span className="monthly__blank">{EM_DASH}</span>
                      </td>
                    )
                  }
                  const level = heatLevel(value, maxAbs)
                  const tone = value >= 0 ? 'pos' : 'neg'
                  return (
                    <td key={key} className="monthly__cell">
                      <span
                        className={`monthly__value num monthly__value--${tone}-${level}`}
                        title={`${key}: ${formatPercentSigned(value)}`}
                      >
                        {formatPercentSigned(value, 1)}
                      </span>
                    </td>
                  )
                })}
                <td className="monthly__cell monthly__cell--year">
                  <span className={`num monthly__year-value ${signClass(yearly.get(year))}`}>
                    {formatPercentSigned(yearly.get(year), 1)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="monthly__footer">
        <span>
          <span className="monthly__footer-label">Best month</span>
          <span className="num pos">{formatPercentSigned(returns.best_month_pct)}</span>
        </span>
        <span>
          <span className="monthly__footer-label">Worst month</span>
          <span className="num neg">{formatPercentSigned(returns.worst_month_pct)}</span>
        </span>
        <span>
          <span className="monthly__footer-label">Positive months</span>
          <span className="num">
            {monthly.filter((item) => item.pct !== null && item.pct > 0).length} /{' '}
            {monthly.filter((item) => item.pct !== null).length}
          </span>
        </span>
        <span className="monthly__footer-note">
          Calendar months with no observations are left blank. The first and last month may
          be partial: {formatPercent(returns.hit_rate_pct, 1)} of all trading days were
          positive.
        </span>
      </div>
    </Panel>
  )
}
