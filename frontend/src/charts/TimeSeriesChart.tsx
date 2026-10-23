/**
 * React wrapper around TradingView Lightweight Charts.
 *
 * Deliberately restrained, following the library's own house style: thin
 * lines, hairline axes, muted gridlines, no area gradients (a gradient fill is
 * explicitly out of bounds for this design system, so only line series are
 * used), and a crosshair that reports values to the parent for an external
 * readout rather than drawing a floating bubble over the data.
 */

import {
  createChart,
  CrosshairMode,
  LineSeries,
  LineStyle,
  type DeepPartial,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type AutoscaleInfo,
  type MouseEventParams,
  type Time,
  type TimeChartOptions,
} from 'lightweight-charts'
import { useEffect, useRef } from 'react'

import { easeOutSine, MOTION, prefersReducedMotion } from '../lib/motion'
import { useTheme } from '../lib/theme'
import { fromTime } from './series'
import { chartTheme } from './theme'

export interface SeriesSpec {
  /** Stable identity; used as the key in crosshair readouts. */
  id: string
  label: string
  color: string
  data: LineData<Time>[]
  lineWidth?: 1 | 2
  /** Dashed rendering marks a reference series (e.g. the benchmark). */
  dashed?: boolean
}

/** Values under the crosshair, or `null` when the pointer leaves the chart. */
export interface CrosshairState {
  time: string
  values: Record<string, number>
}

interface TimeSeriesChartProps {
  series: SeriesSpec[]
  /** Fixed pixel height. Ignored when `fill` is set. */
  height?: number
  /**
   * Stretch to the remaining height of a `.panel--fill` body instead of taking
   * a fixed height, so charts sharing a row all reach the same baseline.
   */
  fill?: boolean
  /**
   * Plot the line progressively on first mount instead of appearing complete.
   * Only the initial render animates; range and view changes redraw instantly.
   */
  revealOnMount?: boolean
  /** Milliseconds before the reveal starts, for sequencing with the page. */
  revealDelay?: number
  /** Formats the right price axis and the crosshair line label. */
  valueFormatter: (value: number) => string
  onCrosshair?: (state: CrosshairState | null) => void
  ariaLabel: string
  /** Draws a horizontal reference line, e.g. zero on a returns view. */
  baselineValue?: number
}

export function TimeSeriesChart({
  series,
  height,
  fill,
  revealOnMount,
  revealDelay = 0,
  valueFormatter,
  onCrosshair,
  ariaLabel,
  baselineValue,
}: TimeSeriesChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef(new Map<string, ISeriesApi<'Line'>>())
  // Set when the chart is torn down. Effects clean up in definition order, so
  // the chart is already gone by the time the series and price-line cleanups
  // run; touching a disposed instance throws "Object is disposed".
  const disposedRef = useRef(false)

  // Reveal runs at most once per mounted chart.
  const revealDoneRef = useRef(!revealOnMount || prefersReducedMotion())
  // While revealing, the price scale is pinned to the full data range so the
  // axis does not rescale on every frame as new points arrive.
  const revealingRef = useRef(false)
  const rangeRef = useRef<{ minValue: number; maxValue: number } | null>(null)
  const frameRef = useRef<number>(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Latest props read by the (stable) crosshair handler without re-subscribing.
  const formatterRef = useRef(valueFormatter)
  const crosshairRef = useRef(onCrosshair)
  formatterRef.current = valueFormatter
  crosshairRef.current = onCrosshair

  // Chart-level furniture: grid, axes, crosshair, label colour. Applied when
  // the chart is created and re-applied whenever the theme changes, so a
  // palette switch repaints the frame as well as the series.
  const chartOptions = (): DeepPartial<TimeChartOptions> => {
    const theme = chartTheme()
    return {
      // The size is owned by this component, not by the library: its own
      // `autoSize` observer can deliver a resize after the chart has been
      // removed, which throws "Object is disposed" during a view change.
      autoSize: false,
      layout: {
        background: { color: 'transparent' },
        textColor: theme.textTertiary,
        fontFamily: theme.fontMono,
        fontSize: 10,
        // Attribution is given in the application footer and the README
        // instead, keeping the plot area free of overlay marks.
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: theme.grid, style: LineStyle.Solid },
        horzLines: { color: theme.grid, style: LineStyle.Solid },
      },
      rightPriceScale: {
        borderColor: theme.axis,
        scaleMargins: { top: 0.12, bottom: 0.08 },
        entireTextOnly: true,
      },
      timeScale: {
        borderColor: theme.axis,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: {
          color: theme.crosshair,
          width: 1,
          style: LineStyle.Dotted,
          labelBackgroundColor: theme.surfaceRaised,
        },
        horzLine: {
          color: theme.crosshair,
          width: 1,
          style: LineStyle.Dotted,
          labelBackgroundColor: theme.surfaceRaised,
        },
      },
      localization: {
        priceFormatter: (price: number) => formatterRef.current(price),
      },
      handleScale: { axisPressedMouseMove: false },
    }
  }

  // Create the chart once. Series are added and removed by the effect below.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    // Captured here so the cleanup closes over the same Map instance rather
    // than reading `.current` after unmount.
    const seriesMap = seriesRef.current
    const chart = createChart(host, {
      ...chartOptions(),
      width: Math.max(host.clientWidth, 1),
      height: Math.max(host.clientHeight, 1),
    })
    disposedRef.current = false

    // Track the container ourselves. The callback is guarded, so a resize that
    // is already queued when the view changes is dropped rather than applied
    // to a disposed chart.
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (!entry || disposedRef.current) return
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) chart.applyOptions({ width, height })
    })
    observer.observe(host)

    chart.subscribeCrosshairMove((params: MouseEventParams<Time>) => {
      const report = crosshairRef.current
      if (!report) return

      if (!params.time || !params.point) {
        report(null)
        return
      }

      const values: Record<string, number> = {}
      for (const [id, api] of seriesMap) {
        const point = params.seriesData.get(api) as LineData<Time> | undefined
        if (point && typeof point.value === 'number') values[id] = point.value
      }
      report({ time: fromTime(params.time), values })
    })

    chartRef.current = chart
    return () => {
      // Mark first: the cleanups below run after this one and must not touch
      // a disposed chart.
      disposedRef.current = true
      observer.disconnect()
      chart.remove()
      chartRef.current = null
      seriesMap.clear()
    }
  }, [])

  // Re-apply the chart furniture when the theme changes. The grid, axes and
  // crosshair are owned by the chart instance and would otherwise keep the
  // old theme's colours. The chart subscribes to the theme itself: reading
  // the version during render only worked when a parent happened to
  // re-render, and a live switch could leave dark gridlines on a light page.
  const { theme } = useTheme()
  useEffect(() => {
    chartRef.current?.applyOptions(chartOptions())
  }, [theme])

  // Reconcile series: update in place where possible, add/remove on change.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const theme = chartTheme()
    const present = new Set(series.map((spec) => spec.id))

    for (const [id, api] of seriesRef.current) {
      if (!present.has(id)) {
        chart.removeSeries(api)
        seriesRef.current.delete(id)
      }
    }

    series.forEach((spec) => {
      let api = seriesRef.current.get(spec.id)
      if (!api) {
        api = chart.addSeries(LineSeries, { priceLineVisible: false, lastValueVisible: false })
        seriesRef.current.set(spec.id, api)
      }
      api.applyOptions({
        color: spec.color,
        lineWidth: spec.lineWidth ?? 2,
        lineStyle: spec.dashed ? LineStyle.Dashed : LineStyle.Solid,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 3,
        crosshairMarkerBorderColor: theme.surface,
        crosshairMarkerBackgroundColor: spec.color,
        // During the reveal, report the finished range so the price scale is
        // stable; afterwards defer to the library's own autoscaling.
        autoscaleInfoProvider: (base: () => AutoscaleInfo | null) =>
          revealingRef.current && rangeRef.current
            ? { priceRange: rangeRef.current }
            : base(),
      })
    })

    const longest = series.reduce((max, spec) => Math.max(max, spec.data.length), 0)

    if (revealDoneRef.current || longest < 2) {
      series.forEach((spec) => seriesRef.current.get(spec.id)?.setData(spec.data))
      chart.timeScale().fitContent()
      return
    }

    // ---- Progressive plot -------------------------------------------------
    // Lightweight Charts has no built-in draw animation, so the line is grown
    // a slice at a time. The tail is padded with whitespace points, which
    // occupy the time axis without drawing anything: the horizontal scale is
    // therefore correct from the first frame and only the line advances.
    revealDoneRef.current = true
    revealingRef.current = true

    const values = series.flatMap((spec) => spec.data.map((point) => point.value))
    rangeRef.current = { minValue: Math.min(...values), maxValue: Math.max(...values) }

    const whitespace = series.map((spec) => spec.data.map(({ time }) => ({ time })))
    series.forEach((spec, index) => seriesRef.current.get(spec.id)?.setData(whitespace[index]))
    chart.timeScale().fitContent()

    // Hold the horizontal span across the whole reveal. Left alone, the scale
    // tracks the drawn data and the chart scrolls and rescales on every frame,
    // which reads as a live tape rather than a line being drawn onto a plot.
    //
    // The edge locks have to come off first: they clamp the visible range to
    // the real data, so with a partially-drawn series they would drag the view
    // back to the last plotted point on every frame.
    const fullSpan = { from: 0, to: longest - 1 }
    chart.applyOptions({ timeScale: { fixLeftEdge: false, fixRightEdge: false } })

    const start = performance.now()
    const step = (now: number) => {
      if (disposedRef.current) return
      const t = Math.min((now - start) / MOTION.plot, 1)
      const drawn = Math.max(2, Math.floor(easeOutSine(t) * longest))

      series.forEach((spec, index) => {
        const api = seriesRef.current.get(spec.id)
        if (!api) return
        const count = Math.min(drawn, spec.data.length)
        api.setData([...spec.data.slice(0, count), ...whitespace[index].slice(count)])
      })
      chart.timeScale().setVisibleLogicalRange(fullSpan)

      if (t < 1) {
        frameRef.current = requestAnimationFrame(step)
        return
      }
      revealingRef.current = false
      series.forEach((spec) => seriesRef.current.get(spec.id)?.setData(spec.data))
      chart.applyOptions({ timeScale: { fixLeftEdge: true, fixRightEdge: true } })
      // Re-fit once the real data is in: the scale was last fitted against a
      // whitespace-only series, which leaves the content narrower than the view.
      chart.timeScale().fitContent()
    }

    timerRef.current = setTimeout(() => {
      frameRef.current = requestAnimationFrame(step)
    }, revealDelay)

    return () => {
      clearTimeout(timerRef.current)
      cancelAnimationFrame(frameRef.current)
      revealingRef.current = false
    }
  }, [series, revealDelay])

  // Baseline drawn as a price line on the first series (zero on returns views).
  useEffect(() => {
    const first = series[0] && seriesRef.current.get(series[0].id)
    if (!first || baselineValue === undefined) return

    const theme = chartTheme()
    const line = first.createPriceLine({
      price: baselineValue,
      color: theme.lineStrong,
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: false,
      title: '',
    })
    return () => {
      if (disposedRef.current) return
      first.removePriceLine(line)
    }
  }, [series, baselineValue])

  return (
    <div
      ref={hostRef}
      className={fill ? 'chart chart--fill' : 'chart'}
      style={fill ? undefined : { height }}
      role="img"
      aria-label={ariaLabel}
      onMouseLeave={() => crosshairRef.current?.(null)}
    />
  )
}
