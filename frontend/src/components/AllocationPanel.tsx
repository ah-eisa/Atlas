/**
 * Allocation by asset class and by region.
 *
 * Each breakdown pairs a flat ECharts donut with a tabular legend. The donut
 * conveys proportion at a glance; the legend carries the exact figures, which
 * is what the numbers-first house style demands - a chart is never the only
 * place a value appears.
 */

import { useMemo } from 'react'
import type { EChartsOption } from 'echarts'

import { EChart } from '../charts/EChart'
import { chartTheme, tooltipStyle } from '../charts/theme'
import { formatMoneyCompact, formatPercent } from '../lib/format'
import type { AllocationBucket } from '../lib/types'
import { Panel } from './Panel'

interface AllocationPanelProps {
  byClass: AllocationBucket[]
  byRegion: AllocationBucket[]
  byCurrency?: AllocationBucket[]
  currency: string
}

interface BreakdownProps {
  title: string
  buckets: AllocationBucket[]
  currency: string
}

function donutOption(
  buckets: AllocationBucket[],
  currency: string,
  theme: ReturnType<typeof chartTheme>,
): EChartsOption {
  return {
    // 'expansion' sweeps each ring open around its centre rather than fading
    // it in, so the donut reads as being drawn. The per-segment stagger makes
    // the order of the breakdown legible as it builds.
    animationDuration: 850,
    animationEasing: 'cubicOut',
    animationDelay: (index: number) => 140 + index * 70,
    tooltip: {
      ...tooltipStyle(),
      trigger: 'item',
      formatter: (params: unknown) => {
        const point = params as { name: string; value: number; percent: number }
        return `${point.name}<br/>${formatMoneyCompact(point.value)} ${currency} · ${point.percent.toFixed(1)}%`
      },
    },
    series: [
      {
        type: 'pie',
        radius: ['62%', '88%'],
        center: ['50%', '50%'],
        animationType: 'expansion',
        avoidLabelOverlap: false,
        label: { show: false },
        labelLine: { show: false },
        // A 1px panel-coloured border reads as a hairline gap between segments.
        itemStyle: { borderColor: theme.surface, borderWidth: 1, borderRadius: 0 },
        emphasis: {
          scale: false,
          itemStyle: { color: theme.accent },
        },
        data: buckets.map((bucket, index) => ({
          name: bucket.key,
          value: bucket.value,
          itemStyle: { color: theme.categorical[index % theme.categorical.length] },
        })),
      },
    ],
  }
}

function Breakdown({ title, buckets, currency }: BreakdownProps) {
  const theme = chartTheme()
  // The theme is a dependency: the segment colours are baked into the option,
  // so switching the palette has to rebuild it.
  const option = useMemo(() => donutOption(buckets, currency, theme), [buckets, currency, theme])

  return (
    <div className="allocation__group">
      <div className="allocation__caption label">{title}</div>
      <EChart
        option={option}
        height={104}
        ariaLabel={`Allocation by ${title.toLowerCase()}`}
        className="allocation__chart"
      />
      <table className="allocation__legend">
        <tbody>
          {buckets.map((bucket, index) => (
            <tr key={bucket.key}>
              <td className="allocation__swatch-cell">
                <span
                  className="allocation__swatch"
                  style={{ background: theme.categorical[index % theme.categorical.length] }}
                />
              </td>
              <td className="allocation__key">{bucket.key}</td>
              <td className="allocation__value num">{formatMoneyCompact(bucket.value)}</td>
              <td className="allocation__pct num muted">{formatPercent(bucket.allocation_pct, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AllocationPanel({ byClass, byRegion, byCurrency, currency }: AllocationPanelProps) {
  return (
    <Panel title="Allocation" subtitle={`${currency} · share of market value`}>
      <div className={byCurrency ? 'allocation allocation--three' : 'allocation'}>
        <Breakdown title="Asset class" buckets={byClass} currency={currency} />
        <Breakdown title="Region" buckets={byRegion} currency={currency} />
        {byCurrency ? (
          <Breakdown title="Currency" buckets={byCurrency} currency={currency} />
        ) : null}
      </div>
    </Panel>
  )
}
