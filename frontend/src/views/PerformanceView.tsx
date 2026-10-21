/**
 * The performance view: how the portfolio compounded, where the money went,
 * and how long it was underwater.
 */

import { DrawdownPanel } from '../components/DrawdownPanel'
import { FxAttributionPanel } from '../components/FxAttributionPanel'
import { MonthlyReturnsPanel } from '../components/MonthlyReturnsPanel'
import { PerformancePanel } from '../components/PerformancePanel'
import { ReturnsDistributionPanel } from '../components/ReturnsDistributionPanel'
import type { PortfolioState } from '../lib/types'

interface PerformanceViewProps {
  state: PortfolioState
}

export default function PerformanceView({ state }: PerformanceViewProps) {
  const analytics = state.analytics
  if (!analytics) return null

  const { summary, history, returns, risk, holdings } = analytics
  const currency = summary.base_currency

  return (
    <main className="app__main">
      <PerformancePanel
        history={history}
        summary={summary}
        returns={returns}
        currency={currency}
      />
      <div className="row row--split">
        <DrawdownPanel history={history} risk={risk} />
        <ReturnsDistributionPanel returns={returns} />
      </div>
      <FxAttributionPanel summary={summary} holdings={holdings.holdings} currency={currency} />
      <MonthlyReturnsPanel returns={returns} />
    </main>
  )
}
