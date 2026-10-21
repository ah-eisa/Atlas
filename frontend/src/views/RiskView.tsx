/**
 * The risk view: the full risk picture, then the tools for interrogating it
 * (drift, attribution, replay and a benchmark comparison).
 */

import { AttributionPanel } from '../components/AttributionPanel'
import { BenchmarkPanel } from '../components/BenchmarkPanel'
import { CorrelationPanel } from '../components/CorrelationPanel'
import { DriftPanel } from '../components/DriftPanel'
import { ReplayPanel } from '../components/ReplayPanel'
import { RiskContributionPanel } from '../components/RiskContributionPanel'
import { RiskPanel } from '../components/RiskPanel'
import type { DataConfig } from '../lib/api'
import type { PortfolioState } from '../lib/types'

interface RiskViewProps {
  state: PortfolioState
  config: DataConfig
}

export default function RiskView({ state, config }: RiskViewProps) {
  const analytics = state.analytics
  if (!analytics) return null

  const { summary, history, risk } = analytics
  const currency = summary.base_currency

  return (
    <main className="app__main">
      <div className="row row--split">
        <BenchmarkPanel risk={risk} config={config} />
        <RiskContributionPanel risk={risk} />
      </div>
      <div className="row row--risk">
        <RiskPanel risk={risk} currency={currency} />
        <CorrelationPanel correlation={risk.correlation} lookbackDays={risk.lookback_days} />
      </div>
      <DriftPanel summary={summary} currency={currency} config={config} />
      <AttributionPanel summary={summary} />
      <ReplayPanel
        config={config}
        currency={currency}
        historyStart={analytics.health.history_start}
        history={history}
      />
    </main>
  )
}
