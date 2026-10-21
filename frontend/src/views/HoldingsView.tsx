/**
 * The holdings view: what is owned, what it cost, what it is worth, and the
 * editors for changing it. Also the place the app lands when a live portfolio
 * is empty or its prices are unavailable, so it must work without analytics.
 */

import { AllocationPanel } from '../components/AllocationPanel'
import { CashFlowEditor } from '../components/CashFlowEditor'
import { HoldingsPanel } from '../components/HoldingsPanel'
import { Panel } from '../components/Panel'
import { PortfolioEditor } from '../components/PortfolioEditor'
import type { DataConfig } from '../lib/api'
import type { PortfolioState } from '../lib/types'

interface HoldingsViewProps {
  state: PortfolioState
  config: DataConfig
  onReload: () => void
  onApiKey: (key: string) => void
}

function SnapshotNotice() {
  return (
    <Panel title="Editing" subtitle="snapshot mode is read-only">
      <div className="snapshot-note">
        <p>
          This view is running from the committed <code>snapshot.json</code>. Positions can
          be inspected but not changed, because a static file has no database behind it.
        </p>
        <p>
          Start the FastAPI service and switch the data source to add positions, refresh
          prices, set the reporting currency, and export the stored portfolio.
        </p>
        <a className="button button--primary" href="?source=api#/holdings">
          Open live API
        </a>
      </div>
    </Panel>
  )
}

export default function HoldingsView({ state, config, onReload, onApiKey }: HoldingsViewProps) {
  const analytics = state.analytics
  const apiKeyRequired = state.settings?.api_key_required ?? false

  if (!analytics) {
    return (
      <main className="app__main">
        <Panel title="Holdings" subtitle={`${state.positions.length} stored positions`}>
          <div className="state state--inline">
            <span className="state__kicker">
              {state.positions.length === 0 ? 'Empty portfolio' : 'Pricing unavailable'}
            </span>
            <span className="state__title">
              {state.positions.length === 0
                ? 'Add the first position to build the portfolio'
                : 'Positions are stored, but market data could not be loaded'}
            </span>
            <p className="state__detail">
              {state.error ??
                'The editor is ready. Analytics will appear once the portfolio has at least one position and prices can be fetched.'}
            </p>
          </div>
        </Panel>
        {state.editable ? (
          <PortfolioEditor
            positions={state.positions}
            config={config}
            apiKeyRequired={apiKeyRequired}
            baseCurrency={state.baseCurrency}
            onSaved={onReload}
            onApiKey={onApiKey}
          />
        ) : null}
      </main>
    )
  }

  const { summary, holdings } = analytics
  const currency = summary.base_currency

  return (
    <main className="app__main">
      <HoldingsPanel
        holdings={holdings.holdings}
        totalValue={holdings.total_value}
        currency={currency}
      />
      <AllocationPanel
        byClass={summary.allocation_by_class}
        byRegion={summary.allocation_by_region}
        byCurrency={summary.allocation_by_currency}
        currency={currency}
      />
      {state.editable ? (
        <PortfolioEditor
          positions={state.positions}
          config={config}
          apiKeyRequired={apiKeyRequired}
          baseCurrency={currency}
          onSaved={onReload}
          onApiKey={onApiKey}
        />
      ) : (
        <SnapshotNotice />
      )}
      {state.editable ? (
        <CashFlowEditor
          cashFlows={state.cashFlows}
          config={config}
          baseCurrency={currency}
          onSaved={onReload}
          onApiKey={onApiKey}
        />
      ) : null}
    </main>
  )
}
