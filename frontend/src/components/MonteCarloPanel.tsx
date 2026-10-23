/**
 * Monte Carlo outcome distribution: a percentile fan over the next 252 trading
 * days, the terminal-value histogram, and the summary probabilities.
 *
 * The fan is built from stacked *flat* bands (each a solid fill, never a
 * gradient): the p5 series is an invisible base, and each visible band carries
 * the delta to the next percentile. A separate unstacked series draws the
 * median at its true value on the same axis.
 */

import { useMemo } from 'react'
import type { EChartsOption } from 'echarts'

import { EChart } from '../charts/EChart'
import { axisLabelStyle, chartTheme, tooltipStyle, useChartTheme } from '../charts/theme'
import {
  formatDate,
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  formatPercentSigned,
  signClass,
} from '../lib/format'
import type { MonteCarloPayload } from '../lib/types'
import { Panel } from './Panel'

interface MonteCarloPanelProps {
  montecarlo: MonteCarloPayload
  currency: string
}

/** Element-wise difference, used to turn percentiles into stackable bands. */
function delta(upper: number[], lower: number[]): number[] {
  return upper.map((value, index) => value - lower[index])
}

function fanOption(
  mc: MonteCarloPayload,
  currency: string,
  theme: ReturnType<typeof chartTheme>,
): EChartsOption {
  const { p5, p25, p50, p75, p95 } = mc.percentile_bands

  const invisible = {
    type: 'line' as const,
    stack: 'fan',
    showSymbol: false,
    lineStyle: { opacity: 0 },
    silent: true,
  }
  const band = (color: string) => ({
    ...invisible,
    areaStyle: { color, opacity: 1 },
  })

  return {
    // ECharts draws line series left-to-right on first render, so simply
    // enabling animation makes the fan open outward from today's value.
    animation: true,
    animationDuration: 1100,
    animationEasing: 'cubicOut',
    animationDelay: 260,
    grid: { left: 62, right: 14, top: 16, bottom: 30 },
    tooltip: {
      ...tooltipStyle(),
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: theme.crosshair, width: 1, type: 'dotted' } },
      formatter: (params: unknown) => {
        const points = params as { dataIndex: number }[]
        if (!points?.length) return ''
        const index = points[0].dataIndex
        const rows: [string, number][] = [
          ['p95', p95[index]],
          ['p75', p75[index]],
          ['p50', p50[index]],
          ['p25', p25[index]],
          ['p5', p5[index]],
        ]
        const header = `${formatDate(mc.dates[index])}  ·  day ${index}`
        const body = rows
          .map(([label, value]) => `${label.padEnd(4)} ${formatMoneyCompact(value)}`)
          .join('<br/>')
        return `${header}<br/>${body}`
      },
    },
    xAxis: {
      type: 'category',
      data: mc.dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      // ~monthly ticks across a 252-day horizon.
      axisLabel: {
        ...axisLabelStyle(),
        interval: Math.floor(mc.dates.length / 6),
        formatter: (value: string) => value.slice(0, 7),
      },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: theme.grid } },
      axisLabel: { ...axisLabelStyle(), formatter: (value: number) => formatMoneyCompact(value) },
    },
    series: [
      { ...invisible, name: 'p5-base', data: p5, areaStyle: { opacity: 0 } },
      { ...band(theme.band), name: 'p5-p25', data: delta(p25, p5) },
      { ...band(theme.bandInner), name: 'p25-p50', data: delta(p50, p25) },
      { ...band(theme.bandInner), name: 'p50-p75', data: delta(p75, p50) },
      { ...band(theme.band), name: 'p75-p95', data: delta(p95, p75) },
      {
        type: 'line',
        name: 'median',
        data: p50,
        showSymbol: false,
        lineStyle: { color: theme.accent, width: 2 },
        z: 3,
        markLine: {
          silent: true,
          symbol: 'none',
          label: {
            formatter: 'today',
            color: theme.textTertiary,
            fontFamily: theme.fontMono,
            fontSize: 9,
            position: 'insideEndTop',
          },
          lineStyle: { color: theme.lineStrong, width: 1, type: 'solid' },
          data: [{ yAxis: mc.start_value }],
        },
      },
    ],
    // Referenced in the tooltip header only; keeps the currency out of axes.
    aria: { enabled: true, label: { description: `Simulated portfolio value in ${currency}` } },
  }
}

function histogramOption(
  mc: MonteCarloPayload,
  theme: ReturnType<typeof chartTheme>,
): EChartsOption {
  const labels = mc.histogram.map((bin) => bin.start)
  // Index of the bin containing today's value, for the break-even marker.
  const breakEven = mc.histogram.findIndex(
    (bin) => mc.start_value >= bin.start && mc.start_value < bin.end,
  )

  return {
    // Bars grow up from the axis, left to right across the distribution.
    animation: true,
    animationDuration: 520,
    animationEasing: 'cubicOut',
    animationDelay: (index: number) => 300 + index * 9,
    grid: { left: 8, right: 12, top: 12, bottom: 26, containLabel: true },
    tooltip: {
      ...tooltipStyle(),
      trigger: 'axis',
      axisPointer: { type: 'none' },
      formatter: (params: unknown) => {
        const points = params as { dataIndex: number }[]
        if (!points?.length) return ''
        const bin = mc.histogram[points[0].dataIndex]
        return `${formatMoneyCompact(bin.start)} – ${formatMoneyCompact(bin.end)}<br/>${formatPercent(bin.probability, 2)} of paths`
      },
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      axisLabel: {
        ...axisLabelStyle(),
        interval: Math.floor(labels.length / 3),
        formatter: (value: string) => formatMoneyCompact(Number(value)),
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
        data: mc.histogram.map((bin) => bin.probability),
        barCategoryGap: '8%',
        itemStyle: { color: theme.accentDim },
        markLine:
          breakEven >= 0
            ? {
                silent: true,
                symbol: 'none',
                lineStyle: { color: theme.textTertiary, width: 1, type: 'dashed' },
                label: { show: false },
                data: [{ xAxis: breakEven }],
              }
            : undefined,
      },
    ],
  }
}

/** The percentile fan: the projection itself. */
export function MonteCarloPanel({ montecarlo, currency }: MonteCarloPanelProps) {
  const theme = useChartTheme()
  const fan = useMemo(() => fanOption(montecarlo, currency, theme), [montecarlo, currency, theme])
  const subtitle = `${montecarlo.paths.toLocaleString('en-GB')} paths · ${montecarlo.horizon_days} trading days`

  return (
    <Panel title="Monte Carlo" subtitle={subtitle} className="panel--fill">
      <div className="montecarlo">
        <div className="montecarlo__legend">
          <span className="montecarlo__legend-item">
            <span className="montecarlo__key montecarlo__key--outer" aria-hidden="true" />
            5th – 95th percentile
          </span>
          <span className="montecarlo__legend-item">
            <span className="montecarlo__key montecarlo__key--inner" aria-hidden="true" />
            25th – 75th percentile
          </span>
          <span className="montecarlo__legend-item">
            <span className="montecarlo__key montecarlo__key--median" aria-hidden="true" />
            median
          </span>
        </div>
        <EChart
          option={fan}
          fill
          ariaLabel={`Simulated portfolio value over the next ${montecarlo.horizon_days} trading days, percentile bands`}
        />
      </div>
    </Panel>
  )
}

/** Where those paths land after a year, and how likely each outcome is. */
export function OutcomeDistributionPanel({ montecarlo, currency }: MonteCarloPanelProps) {
  const theme = useChartTheme()
  const histogram = useMemo(() => histogramOption(montecarlo, theme), [montecarlo, theme])
  const lossProbability = montecarlo.probability_below_start_pct

  return (
    <Panel title="Outcome" subtitle={`terminal value, ${currency}`}>
      <div className="montecarlo__aside">
        <EChart
          option={histogram}
          height={132}
          ariaLabel="Histogram of simulated portfolio values after one year"
        />

        <table className="readout montecarlo__summary">
          <tbody>
            <tr>
              <td className="readout__label">Expected</td>
              <td className="readout__value num">{formatMoney(montecarlo.expected_value)}</td>
            </tr>
            <tr>
              <td className="readout__label">Median (p50)</td>
              <td className="readout__value num">{formatMoney(montecarlo.median_value)}</td>
            </tr>
            <tr>
              <td className="readout__label">Expected return</td>
              <td className={`readout__value num ${signClass(montecarlo.expected_return_pct)}`}>
                {formatPercentSigned(montecarlo.expected_return_pct)}
              </td>
            </tr>
            <tr>
              <td className="readout__label">P(loss)</td>
              <td className={`readout__value num ${lossProbability > 0.5 ? 'neg' : ''}`}>
                {formatPercent(lossProbability, 1)}
              </td>
            </tr>
            <tr>
              <td className="readout__label">Worst 5%</td>
              <td className="readout__value num neg">{formatMoney(montecarlo.final_values.p5)}</td>
            </tr>
            <tr>
              <td className="readout__label">Best 5%</td>
              <td className="readout__value num pos">{formatMoney(montecarlo.final_values.p95)}</td>
            </tr>
          </tbody>
        </table>

        <p className="montecarlo__assumptions">
          {montecarlo.assumptions.distribution}, {montecarlo.assumptions.correlation}, fitted on{' '}
          {montecarlo.assumptions.lookback_days} trading days. Rebalancing:{' '}
          {montecarlo.assumptions.rebalancing}. Past distributions do not bound future outcomes.
        </p>
      </div>
    </Panel>
  )
}
