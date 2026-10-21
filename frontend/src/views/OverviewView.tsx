/**
 * The overview view: the whole-portfolio answer on one screen.
 *
 * Loaded on demand so the application shell and the KPI band can paint
 * without waiting for the charting libraries.
 */

import { AllocationPanel } from '../components/AllocationPanel'
import { BenchmarkPanel } from '../components/BenchmarkPanel'
import { HoldingsPanel } from '../components/HoldingsPanel'
import { KpiStrip } from '../components/KpiStrip'
import { PerformancePanel } from '../components/PerformancePanel'
import { RiskContributionPanel } from '../components/RiskContributionPanel'
import type { DataConfig } from '../lib/api'
import type { PortfolioState } from '../lib/types'

interface OverviewViewProps {
  state: PortfolioState
  config: DataConfig
}

export default function OverviewView({ state, config }: OverviewViewProps) {
  const analytics = state.analytics
  if (!analytics) return null

  const { summary, history, returns, risk, montecarlo, holdings } = analytics
  const currency = summary.base_currency

  return (
    <main className="app__main">
      <KpiStrip risk={risk} montecarlo={montecarlo} summary={summary} currency={currency} />

      <div className="row row--overview">
        <PerformancePanel
          history={history}
          summary={summary}
          returns={returns}
          currency={currency}
        />
        <AllocationPanel
          byClass={summary.allocation_by_class}
          byRegion={summary.allocation_by_region}
          currency={currency}
        />
      </div>

      <div className="row row--split">
        <BenchmarkPanel risk={risk} config={config} />
        <RiskContributionPanel risk={risk} />
      </div>

      <HoldingsPanel
        holdings={holdings.holdings}
        totalValue={holdings.total_value}
        currency={currency}
      />
    </main>
  )
}
