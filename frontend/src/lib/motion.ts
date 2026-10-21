/**
 * Shared motion primitives for the entrance sequence.
 *
 * The house rule: motion is used only to introduce data, never to decorate it.
 * Everything here runs once on first load, decelerates into place, and is
 * fully disabled under `prefers-reduced-motion`. Nothing bounces, overshoots
 * or loops — an instrument that fidgets is an instrument you stop trusting.
 */

import { useEffect, useRef, useState } from 'react'

/** Master timing, so the sequence stays coordinated from one place. */
export const MOTION = {
  /** Numbers counting into place. */
  countUp: 1000,
  /** Equity and drawdown curves plotting themselves. */
  plot: 1150,
  /** Per-panel stagger between rows. */
  stagger: 60,
} as const

/**
 * Whether the viewer has asked for reduced motion.
 *
 * Read imperatively rather than via a hook because chart wrappers need it
 * outside of React's render cycle.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Decelerating ease. Fast departure, long settle — the curve that reads as
 * "arriving" rather than "sliding".
 */
export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

/** Gentler deceleration, used where a hard stop would look abrupt. */
export function easeOutSine(t: number): number {
  return Math.sin((t * Math.PI) / 2)
}

/**
 * Drives a value from its previous state to `target` on an animation frame
 * loop, returning the current intermediate value.
 *
 * On first mount the animation starts from zero, which is what produces the
 * "calculating itself" effect. Later changes (a data reload) animate from
 * whatever was last displayed, so the number never jumps.
 *
 * @param target Final value. `null` disables the animation and is passed through.
 * @param delay Milliseconds to wait before starting, for sequencing.
 */
export function useCountUp(target: number | null | undefined, delay = 0): number | null {
  const [value, setValue] = useState<number | null>(() =>
    prefersReducedMotion() ? (target ?? null) : 0,
  )
  const fromRef = useRef(0)
  const frameRef = useRef<number>(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (target === null || target === undefined || !Number.isFinite(target)) {
      setValue(null)
      return
    }

    if (prefersReducedMotion()) {
      setValue(target)
      return
    }

    // A backgrounded tab has its animation frames suspended, so the count-up
    // would freeze at zero and the panel would read as "no data". Show the
    // final figure instead: the entrance animation is decoration, the number
    // is not.
    if (typeof document !== 'undefined' && document.hidden) {
      fromRef.current = target
      setValue(target)
      return
    }

    const from = fromRef.current
    const start = performance.now()

    const step = (now: number) => {
      const elapsed = now - start
      const t = Math.min(elapsed / MOTION.countUp, 1)
      const current = from + (target - from) * easeOutCubic(t)
      setValue(current)
      if (t < 1) {
        frameRef.current = requestAnimationFrame(step)
      } else {
        fromRef.current = target
      }
    }

    timerRef.current = setTimeout(() => {
      frameRef.current = requestAnimationFrame(step)
    }, delay)

    return () => {
      clearTimeout(timerRef.current)
      cancelAnimationFrame(frameRef.current)
    }
  }, [target, delay])

  return value
}
