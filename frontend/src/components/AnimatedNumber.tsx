/**
 * A figure that counts into place on first load.
 *
 * The animating text is overlaid on an invisible copy of the *final* string,
 * so the element is already sized for its end state. Without that, "1,234"
 * growing to "80,325" would widen mid-animation and shove its neighbours
 * around — the tell of a cheap counter. Tabular figures keep the digits from
 * jittering as they change.
 */

import { useCountUp } from '../lib/motion'

interface AnimatedNumberProps {
  /** The true value. `null` renders the formatter's missing-value output. */
  value: number | null | undefined
  /** Formatter applied to both the intermediate and final values. */
  format: (value: number | null | undefined) => string
  /** Milliseconds to wait before counting, used to sequence the page. */
  delay?: number
  className?: string
}

export function AnimatedNumber({ value, format, delay = 0, className }: AnimatedNumberProps) {
  const animated = useCountUp(value, delay)

  return (
    <span className={className ? `counter ${className}` : 'counter'}>
      {/* Reserves the final width; hidden from view but not from assistive
          technology, so the figure is announced once, at its true value,
          rather than counted up from zero. */}
      <span className="counter__reserve">{format(value)}</span>
      <span className="counter__value" aria-hidden="true">
        {format(animated)}
      </span>
    </span>
  )
}
