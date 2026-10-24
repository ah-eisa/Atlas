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
import type { Holding, PortfolioState, Position } from '../lib/types'

interface HoldingsViewProps {
  state: PortfolioState
  config: DataConfig
  onReload: () => void
  onApiKey: (key: string) => void
  onAddPosition?: () => void
  onEditPosition?: (position: Position) => void
  onDeletePosition?: (id: number) => Promise<void>
  onSwitchSource?: (source: 'api' | 'snapshot') => void
  onOpenTradeModal?: (ticker?: string, type?: 'BUY' | 'SELL') => void
}

function SnapshotNotice({ onSwitchSource }: { onSwitchSource?: (source: 'api' | 'snapshot') => void }) {
  return (
    <Panel title="Editing" subtitle="snapshot mode is read-only">
      <div className="snapshot-note">
        <p>
          This view is running from the committed <code>snapshot.json</code> demo. Positions can
          be inspected but not changed, because a static snapshot has no writable database.
        </p>
        <p>
          Switch to <strong>Live API</strong> mode to create multiple portfolios, add or edit positions,
          and track real-time valuations.
        </p>
        {onSwitchSource ? (
          <button
            type="button"
            className="button button--primary"
            onClick={() => onSwitchSource('api')}
          >
            Switch to Live API
          </button>
        ) : (
          <a className="button button--primary" href="?source=api#/holdings">
            Open live API
          </a>
        )}
      </div>
    </Panel>
  )
}

export default function HoldingsView({
  state,
  config,
  onReload,
  onApiKey,
  onAddPosition,
  onEditPosition,
  onDeletePosition,
  onSwitchSource,
  onOpenTradeModal,
}: HoldingsViewProps) {
  const analytics = state.analytics
  const apiKeyRequired = state.settings?.api_key_required ?? false

  const handleEditHolding = (holding: Holding) => {
    const pos = state.positions.find(
      (p) => p.ticker.toUpperCase() === holding.ticker.toUpperCase(),
    )
    if (pos && onEditPosition) {
      onEditPosition(pos)
    }
  }

  const handleDeleteHolding = async (holding: Holding) => {
    const pos = state.positions.find(
      (p) => p.ticker.toUpperCase() === holding.ticker.toUpperCase(),
    )
    if (pos && onDeletePosition) {
      await onDeletePosition(pos.id)
    }
  }

  if (!analytics) {
    return (
      <main className="app__main">
        <Panel
          title="Holdings"
          subtitle={`${state.positions.length} stored positions`}
          actions={
            state.editable && onAddPosition ? (
              <button
                type="button"
                className="button button--primary"
                onClick={onAddPosition}
              >
                + Add Position
              </button>
            ) : undefined
          }
        >
          <div className="state state--inline">
            <span className="state__kicker">
              {state.positions.length === 0 ? 'Empty portfolio' : 'Pricing unavailable'}
            </span>
            <span className="state__title">
              {state.positions.length === 0
                ? 'Add your first position to build and monitor the portfolio'
                : 'Positions are stored, but market data could not be loaded'}
            </span>
            <p className="state__detail">
              {state.error ??
                'The editor is ready. Analytics and charts will appear once the portfolio has at least one position and prices are fetched.'}
            </p>
            {state.positions.length === 0 && state.editable && onAddPosition && (
              <div style={{ marginTop: 'var(--space-4)' }}>
                <button
                  type="button"
                  className="button button--primary"
                  onClick={onAddPosition}
                >
                  + Add First Position
                </button>
              </div>
            )}
            {!state.editable && (
              <div style={{ marginTop: 'var(--space-4)' }}>
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => onSwitchSource?.('api')}
                >
                  Switch to Live API to Build Portfolio
                </button>
              </div>
            )}
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
        cash={holdings.cash ?? []}
        currency={currency}
        editable={state.editable}
        onAddPosition={onAddPosition}
        onEditHolding={handleEditHolding}
        onDeleteHolding={handleDeleteHolding}
        onOpenTradeModal={onOpenTradeModal}
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
        <SnapshotNotice onSwitchSource={onSwitchSource} />
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
