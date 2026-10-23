/**
 * Underwater chart: how far below its running peak the portfolio has been, at
 * every point in its history.
 *
 * Promoted to a panel of its own rather than a view toggle, because depth and
 * duration of losses is the risk question a drawdown curve answers instantly
 * and an equity curve hides — a portfolio that ends flat looks calm on a value
 * chart even if it fell 25% on the way.
 */

import { useMemo, useState } from 'react'

import { toLineData } from '../charts/series'
import { useChartTheme } from '../charts/theme'
import { TimeSeriesChart, type CrosshairState } from '../charts/TimeSeriesChart'
import { formatDate, formatPercent } from '../lib/format'
import { MOTION } from '../lib/motion'
import type { HistoryPayload, RiskPayload } from '../lib/types'
import { Panel } from './Panel'

interface DrawdownPanelProps {
  history: HistoryPayload
  risk: RiskPayload
}

export function DrawdownPanel({ history, risk }: DrawdownPanelProps) {
  const theme = useChartTheme()
  const [crosshair, setCrosshair] = useState<CrosshairState | null>(null)

  const series = useMemo(
    () => [
      {
        id: 'drawdown',
        label: 'Drawdown',
        color: theme.negative,
        lineWidth: 1 as const,
        data: toLineData(history.dates, history.drawdown_pct),
      },
    ],
    [history, theme],
  )

  const current = history.drawdown_pct[history.drawdown_pct.length - 1]
  const hovered = crosshair?.values.drawdown
  const shown = hovered ?? current
  const drawdown = risk.max_drawdown

  const recovery = drawdown.recovery_date
    ? `recovered ${formatDate(drawdown.recovery_date)}`
    : 'not yet recovered'

  return (
    <Panel title="Drawdown" subtitle="below running peak" className="panel--fill">
      <div className="drawdown">
        <div className="drawdown__legend">
          <span className="drawdown__current">
            <span className="drawdown__caption">
              {crosshair ? formatDate(crosshair.time) : 'Current'}
            </span>
            <span className={`num drawdown__value ${shown && shown < -0.0001 ? 'neg' : ''}`}>
              {formatPercent(shown)}
            </span>
          </span>
          <span className="drawdown__worst">
            <span className="drawdown__caption">Worst</span>
            <span className="num neg">{formatPercent(drawdown.pct)}</span>
            <span className="drawdown__caption">
              {formatDate(drawdown.trough_date)} · {recovery}
            </span>
          </span>
        </div>

        <TimeSeriesChart
          series={series}
          fill
          revealOnMount
          revealDelay={MOTION.stagger * 4}
          valueFormatter={(value) => formatPercent(value, 1)}
          onCrosshair={setCrosshair}
          baselineValue={0}
          ariaLabel="Portfolio drawdown from its running peak over the full history"
        />
      </div>
    </Panel>
  )
}
