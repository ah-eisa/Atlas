/**
 * Daily return distribution.
 *
 * The histogram shows the shape that summary statistics flatten: whether the
 * left tail is long, whether returns cluster near zero, and whether a handful of
 * days carry the period. Bars are coloured only by sign, never by size.
 */

import { useMemo } from 'react'
import type { EChartsOption } from 'echarts'

import { EChart } from '../charts/EChart'
import { axisLabelStyle, chartTheme, tooltipStyle } from '../charts/theme'
import {
  formatDateShort,
  formatPercent,
  formatPercentSigned,
  formatRatio,
  signClass,
} from '../lib/format'
import type { ReturnsPayload } from '../lib/types'
import { Panel } from './Panel'

interface ReturnsDistributionPanelProps {
  returns: ReturnsPayload
}

function histogramOption(returns: ReturnsPayload): EChartsOption {
  const theme = chartTheme()
  const bins = returns.histogram
  const labels = bins.map((bin) => bin.start)
  const firstPositive = bins.findIndex((bin) => bin.end > 0)

  return {
    animation: true,
    animationDuration: 480,
    animationEasing: 'cubicOut',
    animationDelay: (index: number) => 80 + index * 8,
    grid: { left: 8, right: 10, top: 14, bottom: 26, containLabel: true },
    tooltip: {
      ...tooltipStyle(),
      trigger: 'axis',
      axisPointer: { type: 'none' },
      formatter: (params: unknown) => {
        const points = params as { dataIndex: number }[]
        if (!points?.length) return ''
        const bin = bins[points[0].dataIndex]
        const share = returns.observations > 0 ? bin.count / returns.observations : 0
        return `${formatPercent(bin.start, 2)} to ${formatPercent(bin.end, 2)}<br/>${bin.count} days · ${formatPercent(share, 1)}`
      },
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      axisLabel: {
        ...axisLabelStyle(),
        interval: Math.max(2, Math.floor(labels.length / 5)),
        formatter: (value: string) => formatPercent(Number(value), 0),
      },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: theme.grid } },
      axisLabel: { show: false },
    },
    series: [
      {
        type: 'bar',
        data: bins.map((bin) => ({
          value: bin.count,
          itemStyle: {
            color: bin.start < 0 ? theme.negative : theme.positive,
            opacity: bin.start < 0 ? 0.72 : 0.62,
          },
        })),
        barCategoryGap: '12%',
        markLine:
          firstPositive >= 0
            ? {
                silent: true,
                symbol: 'none',
                lineStyle: { color: theme.lineStrong, width: 1, type: 'solid' },
                label: { show: false },
                data: [{ xAxis: firstPositive }],
              }
            : undefined,
      },
    ],
  }
}

export function ReturnsDistributionPanel({ returns }: ReturnsDistributionPanelProps) {
  const option = useMemo(() => histogramOption(returns), [returns])
  const payoff =
    returns.average_gain_pct !== null &&
    returns.average_loss_pct !== null &&
    returns.average_loss_pct < 0
      ? returns.average_gain_pct / Math.abs(returns.average_loss_pct)
      : null

  return (
    <Panel
      title="Return distribution"
      subtitle={`daily · ${returns.observations} observations`}
      className="panel--fill distribution"
    >
      <div className="distribution__chart">
        <EChart
          option={option}
          height={150}
          ariaLabel={`Histogram of ${returns.observations} daily portfolio returns`}
        />
      </div>

      <div className="distribution__stats">
        <div className="distribution__stat">
          <span className="distribution__label">Positive days</span>
          <span className="num distribution__value">
            {formatPercent(returns.hit_rate_pct, 1)}
          </span>
          <span className="distribution__context">
            {returns.positive_days} up / {returns.negative_days} down
          </span>
        </div>
        <div className="distribution__stat">
          <span className="distribution__label">Average gain</span>
          <span className="num distribution__value pos">
            {formatPercentSigned(returns.average_gain_pct)}
          </span>
          <span className="distribution__context">on positive days</span>
        </div>
        <div className="distribution__stat">
          <span className="distribution__label">Average loss</span>
          <span className="num distribution__value neg">
            {formatPercentSigned(returns.average_loss_pct)}
          </span>
          <span className="distribution__context">on negative days</span>
        </div>
        <div className="distribution__stat">
          <span className="distribution__label">Payoff ratio</span>
          <span className="num distribution__value">{formatRatio(payoff)}</span>
          <span className="distribution__context">avg gain / avg loss</span>
        </div>
      </div>

      <div className="distribution__extremes">
        <span>
          <span className="performance__stat-label">Best day</span>
          <span className="num pos">{formatPercentSigned(returns.best_day.pct)}</span>
          <span className="num muted">{formatDateShort(returns.best_day.date)}</span>
        </span>
        <span>
          <span className="performance__stat-label">Worst day</span>
          <span className="num neg">{formatPercentSigned(returns.worst_day.pct)}</span>
          <span className="num muted">{formatDateShort(returns.worst_day.date)}</span>
        </span>
        <span>
          <span className="performance__stat-label">Annualised</span>
          <span className={`num ${signClass(returns.annualized_return_pct)}`}>
            {formatPercentSigned(returns.annualized_return_pct)}
          </span>
        </span>
      </div>

      <p className="panel-note">
        A wide left tail or a payoff ratio below 1.0 means losses are larger or more
        frequent than the hit rate alone suggests. Past daily returns are not a forecast.
      </p>
    </Panel>
  )
}
