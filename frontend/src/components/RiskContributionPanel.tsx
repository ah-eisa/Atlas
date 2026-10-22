/**
 * Where the portfolio's risk actually comes from.
 *
 * Weight alone is an incomplete answer: a 7% position in a volatile,
 * correlated asset can contribute more variance than a 17% position in a
 * diversified fund. The rows compare capital weight with contribution to
 * portfolio variance, using the Euler decomposition returned by the API.
 */

import { formatPercent, formatRatio } from '../lib/format'
import type { RiskPayload } from '../lib/types'
import { Panel } from './Panel'

interface RiskContributionPanelProps {
  risk: RiskPayload
}

export function RiskContributionPanel({ risk }: RiskContributionPanelProps) {
  const contributions = [...risk.risk_contribution].sort(
    (a, b) => b.contribution_pct - a.contribution_pct,
  )
  const largest = contributions[0]?.contribution_pct ?? 0
  const concentration = risk.concentration

  return (
    <Panel
      title="Risk contribution"
      subtitle="Euler decomposition · share of variance"
      className="risk-contribution"
    >
      <div className="concentration">
        <div className="concentration__stat">
          <span className="concentration__label">Effective holdings</span>
          <span className="num concentration__value">
            {formatRatio(concentration.effective_holdings)}
          </span>
          <span className="concentration__context">1 / HHI</span>
        </div>
        <div className="concentration__stat">
          <span className="concentration__label">Top five weight</span>
          <span className="num concentration__value">
            {formatPercent(concentration.top_five_pct, 1)}
          </span>
          <span className="concentration__context">of capital</span>
        </div>
        <div className="concentration__stat">
          <span className="concentration__label">Largest position</span>
          <span className="num concentration__value">
            {formatPercent(concentration.largest_pct, 1)}
          </span>
          <span className="concentration__context">of capital</span>
        </div>
      </div>

      <div className="risk-contribution__rows">
        <div className="risk-contribution__legend" aria-hidden="true">
          <span>Position</span>
          <span>Weight</span>
          <span>Risk share</span>
          <span>Ratio</span>
        </div>
        {contributions.map((item) => {
          const ratio = item.weight > 0 ? item.contribution_pct / item.weight : null
          const weightWidth = largest > 0 ? (item.weight / largest) * 100 : 0
          const riskWidth = largest > 0 ? (item.contribution_pct / largest) * 100 : 0
          return (
            <div key={item.ticker} className="risk-contribution__row">
              <span className="num risk-contribution__ticker">{item.ticker}</span>
              <span className="num risk-contribution__figure">
                {formatPercent(item.weight, 1)}
              </span>
              <span className="num risk-contribution__figure">
                {formatPercent(item.contribution_pct, 1)}
              </span>
              <span
                className={
                  ratio !== null && ratio > 1.25
                    ? 'num risk-contribution__ratio neg'
                    : 'num risk-contribution__ratio'
                }
              >
                {ratio === null ? '—' : `${formatRatio(ratio)}×`}
              </span>
              <span className="risk-contribution__bars" aria-hidden="true">
                <span
                  className="risk-contribution__bar risk-contribution__bar--weight"
                  style={{ width: `${weightWidth}%` }}
                />
                <span
                  className="risk-contribution__bar risk-contribution__bar--risk"
                  style={{ width: `${riskWidth}%` }}
                />
              </span>
            </div>
          )
        })}
      </div>

      <p className="panel-note">
        A ratio above 1.00 means the position contributes more risk than its capital
        weight. Risk shares sum to 100% and include the effect of correlation, so a
        single volatile holding can dominate a diversified book.
      </p>
    </Panel>
  )
}
