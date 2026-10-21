/**
 * The data view: provenance, freshness, the source switch, the API key and
 * portfolio management. Works with or without analytics, because it is the
 * view that explains why analytics might be missing.
 */

import { DataPanel } from '../components/DataPanel'
import type { DataConfig } from '../lib/api'
import type { PortfolioState } from '../lib/types'

interface DataViewProps {
  state: PortfolioState
  config: DataConfig
  refreshing: boolean
  onRefresh: () => void
  onReload: () => void
  onApiKey: (key: string) => void
  onPortfolio: (id: number) => void
}

export default function DataView(props: DataViewProps) {
  return (
    <main className="app__main">
      <DataPanel {...props} />
    </main>
  )
}
