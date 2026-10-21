/**
 * Correlation heatmap of daily returns between every pair of holdings.
 *
 * Palette: a single-hue sequential ramp, so magnitude is encoded by luminance
 * alone. A rainbow scale would imply categories that do not exist and would
 * mislead about the distance between adjacent values.
 */

import { useMemo } from 'react'
import type { EChartsOption } from 'echarts'

import { EChart } from '../charts/EChart'
import { axisLabelStyle, chartTheme, tooltipStyle } from '../charts/theme'
import { formatCorrelation } from '../lib/format'
import type { RiskPayload } from '../lib/types'
import { Panel } from './Panel'

interface CorrelationPanelProps {
  correlation: RiskPayload['correlation']
  lookbackDays: number
}

/** Pick a legible label colour for a cell, given how light its fill is. */
function labelColor(normalised: number, theme: ReturnType<typeof chartTheme>): string {
  return normalised > 0.62 ? theme.surface : theme.textSecondary
}

function heatmapOption(correlation: RiskPayload['correlation']): EChartsOption {
  const theme = chartTheme()
  const { tickers, matrix } = correlation

  const finite = matrix.flat().filter((value): value is number => value !== null && Number.isFinite(value))
  const min = finite.length ? Math.min(...finite) : 0
  const max = 1

  // y is reversed so the leading diagonal runs top-left to bottom-right, which
  // is how a correlation matrix is conventionally read.
  const data: { value: [number, number, number]; label: { color: string } }[] = []
  matrix.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      if (value === null || !Number.isFinite(value)) return
      const normalised = max === min ? 1 : (value - min) / (max - min)
      data.push({
        value: [columnIndex, tickers.length - 1 - rowIndex, value],
        label: { color: labelColor(normalised, theme) },
      })
    })
  })

  return {
    // Cells scale in on a short diagonal cascade. Kept brief: 144 cells with a
    // long stagger would read as a loading state rather than an entrance.
    animation: true,
    animationDuration: 420,
    animationEasing: 'cubicOut',
    animationDelay: (index: number) => index * 3,
    grid: { left: 66, right: 8, top: 8, bottom: 58, containLabel: false },
    tooltip: {
      ...tooltipStyle(),
      formatter: (params: unknown) => {
        const point = params as { value: [number, number, number] }
        const [x, y, value] = point.value
        const a = tickers[x]
        const b = tickers[tickers.length - 1 - y]
        return `${a} · ${b}<br/>correlation ${formatCorrelation(value)}`
      },
    },
    xAxis: {
      type: 'category',
      data: tickers,
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      splitArea: { show: false },
      axisLabel: { ...axisLabelStyle(), rotate: 45, interval: 0 },
    },
    yAxis: {
      type: 'category',
      data: [...tickers].reverse(),
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      splitArea: { show: false },
      axisLabel: { ...axisLabelStyle(), interval: 0 },
    },
    visualMap: {
      show: false,
      type: 'continuous',
      min,
      max,
      inRange: { color: theme.sequential },
    },
    series: [
      {
        type: 'heatmap',
        data,
        label: {
          show: true,
          fontFamily: theme.fontMono,
          fontSize: 9,
          formatter: (params: unknown) => {
            const point = params as { value: [number, number, number] }
            return formatCorrelation(point.value[2])
          },
        },
        // Hairline gaps between cells, matching the panel grid elsewhere.
        itemStyle: { borderColor: theme.surface, borderWidth: 1 },
        emphasis: {
          itemStyle: { borderColor: theme.accent, borderWidth: 1 },
        },
      },
    ],
  }
}

export function CorrelationPanel({ correlation, lookbackDays }: CorrelationPanelProps) {
  const theme = chartTheme()
  const option = useMemo(() => heatmapOption(correlation), [correlation])

  const finite = correlation.matrix
    .flat()
    .filter((value): value is number => value !== null && Number.isFinite(value))
  const min = finite.length ? Math.min(...finite) : 0

  return (
    <Panel title="Correlation" subtitle={`daily returns · ${lookbackDays} days`}>
      <div className="correlation">
        <EChart
          option={option}
          height={420}
          ariaLabel="Correlation matrix of daily returns between holdings"
        />
        <div className="correlation__scale">
          <span className="num">{formatCorrelation(min)}</span>
          <span className="correlation__ramp" aria-hidden="true">
            {theme.sequential.map((color) => (
              <span key={color} style={{ background: color }} />
            ))}
          </span>
          <span className="num">1.00</span>
          <span className="correlation__note">
            Lighter cells move together; darker cells diversify each other.
          </span>
        </div>
      </div>
    </Panel>
  )
}
