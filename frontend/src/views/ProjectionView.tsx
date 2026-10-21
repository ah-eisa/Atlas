/**
 * The projection view: what the next year plausibly looks like, and what the
 * model assumes.
 */

import { KpiStrip } from '../components/KpiStrip'
import { MonteCarloPanel, OutcomeDistributionPanel } from '../components/MonteCarloPanel'
import { ProjectionNotesPanel } from '../components/ProjectionNotesPanel'
import type { PortfolioState } from '../lib/types'

interface ProjectionViewProps {
  state: PortfolioState
}

export default function ProjectionView({ state }: ProjectionViewProps) {
  const analytics = state.analytics
  if (!analytics) return null

  const { summary, risk, montecarlo } = analytics
  const currency = summary.base_currency

  return (
    <main className="app__main">
      <KpiStrip risk={risk} montecarlo={montecarlo} summary={summary} currency={currency} />
      <div className="row row--projection">
        <MonteCarloPanel montecarlo={montecarlo} currency={currency} />
        <OutcomeDistributionPanel montecarlo={montecarlo} currency={currency} />
      </div>
      <ProjectionNotesPanel montecarlo={montecarlo} currency={currency} />
    </main>
  )
}
