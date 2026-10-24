/**
 * Inline SVG sparkline.
 *
 * Used per row in the holdings grid and inline in the top bar. Hand-rolled
 * rather than pulled from a chart library: at this size a charting runtime
 * would cost far more than the twenty lines of path maths it replaces, and
 * twelve canvas instances in a table would be wasteful.
 *
 * The stroke colour encodes the direction of travel over the window, so it
 * carries data rather than decoration.
 */

import { useId } from 'react'

export type SparklineTone = 'auto' | 'accent' | 'neutral'

interface SparklineProps {
  values: number[]
  width?: number
  height?: number
  tone?: SparklineTone
  /** Accessible description; the graphic is hidden from assistive tech otherwise. */
  ariaLabel?: string
  /** Marks the final point with a small dot. */
  showEndpoint?: boolean
  /** Shades the area under the line, fading towards the baseline. */
  area?: boolean
  strokeWidth?: number
  /** Stretches the graphic to the width of its container. */
  fluid?: boolean
}

function toneColor(tone: SparklineTone, rising: boolean): string {
  if (tone === 'accent') return 'var(--accent)'
  if (tone === 'neutral') return 'var(--text-tertiary)'
  return rising ? 'var(--positive)' : 'var(--negative)'
}

export function Sparkline({
  values,
  width = 96,
  height = 22,
  tone = 'auto',
  ariaLabel,
  showEndpoint = false,
  area = false,
  strokeWidth = 1,
  fluid = false,
}: SparklineProps) {
  const clipId = useId()
  const points = values.filter((value) => Number.isFinite(value))

  if (points.length < 2) {
    return <svg width={width} height={height} aria-hidden="true" />
  }

  const min = Math.min(...points)
  const max = Math.max(...points)
  // A flat series would divide by zero; render it down the vertical centre.
  const span = max - min || 1
  const inset = 1.5

  const x = (index: number) => (index / (points.length - 1)) * width
  const y = (value: number) => inset + (1 - (value - min) / span) * (height - inset * 2)

  const path = points.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(' ')
  const rising = points[points.length - 1] >= points[0]
  const color = toneColor(tone, rising)

  return (
    <svg
      width={fluid ? '100%' : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : 'true'}
      focusable="false"
    >
      <clipPath id={clipId}>
        <rect x="0" y="0" width={width} height={height} />
      </clipPath>
      {area ? (
        <defs>
          <linearGradient id={`${clipId}-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.24" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
      ) : null}
      <g clipPath={`url(#${clipId})`}>
        {area ? <path d={`${path} L${width},${height} L0,${height} Z`} fill={`url(#${clipId}-fill)`} /> : null}
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {showEndpoint ? (
          <circle cx={x(points.length - 1)} cy={y(points[points.length - 1])} r={1.75} fill={color} />
        ) : null}
      </g>
    </svg>
  )
}
