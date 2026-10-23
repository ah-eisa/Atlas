/**
 * Primary navigation.
 *
 * Eleven views are too many to read as one flat row, so they are grouped by
 * what they are about: the portfolio's analytics, the book of positions and
 * trades, the wider markets, and where the data comes from. A single
 * indicator slides to the current view, which is the one piece of motion in
 * the chrome: it answers the click and shows where you went.
 *
 * Keyboard: Left/Right (and Home/End) move between views inside the bar; the
 * `[` and `]` shortcuts elsewhere in the app step to the previous/next view.
 */

import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

import { NAV_GROUPS } from '../lib/navigation'
import type { ViewKey } from '../lib/useHashRoute'

interface PrimaryNavProps {
  view: ViewKey
  analyticsReady: boolean
  holdingsCount: number
}

export function PrimaryNav({ view, analyticsReady, holdingsCount }: PrimaryNavProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)
  const [edges, setEdges] = useState({ start: false, end: false })

  const updateEdges = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    setEdges({
      start: el.scrollLeft > 4,
      end: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    })
  }, [])

  // Measure the current view's link so the indicator can sit under it, and
  // bring the link into view on narrow screens.
  const measure = useCallback(() => {
    const scroller = scrollerRef.current
    const link = scroller?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!scroller || !link) {
      setIndicator(null)
      return
    }
    setIndicator({ left: link.offsetLeft, width: link.offsetWidth })
    updateEdges()
  }, [updateEdges])

  useLayoutEffect(() => {
    measure()
    const scroller = scrollerRef.current
    const link = scroller?.querySelector<HTMLElement>('[aria-current="page"]')
    link?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [view, analyticsReady, holdingsCount, measure])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    // Web fonts change link widths once they load.
    void document.fonts?.ready.then(measure)
    return () => observer.disconnect()
  }, [measure])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
    if (!keys.includes(event.key)) return
    const links = Array.from(
      scrollerRef.current?.querySelectorAll<HTMLAnchorElement>('a.nav__link') ?? [],
    )
    if (links.length === 0) return
    const current = links.indexOf(document.activeElement as HTMLAnchorElement)
    let next = current
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = links.length - 1
    else if (current < 0) next = links.findIndex((l) => l.getAttribute('aria-current') === 'page')
    else next = (current + (event.key === 'ArrowRight' ? 1 : -1) + links.length) % links.length
    event.preventDefault()
    links[Math.max(0, next)].focus()
  }

  const className = [
    'nav',
    edges.start ? 'nav--fade-start' : '',
    edges.end ? 'nav--fade-end' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <nav className={className} aria-label="Primary" onKeyDown={onKeyDown}>
      <div className="nav__scroller" ref={scrollerRef} onScroll={updateEdges}>
        {NAV_GROUPS.map((group) => {
          const groupActive = group.views.some((item) => item.key === view)
          return (
            <div
              key={group.label}
              className={groupActive ? 'nav__group nav__group--active' : 'nav__group'}
              role="group"
              aria-label={group.label}
            >
              <span className="nav__group-label" aria-hidden="true">
                {group.label}
              </span>
              {group.views.map((item) => {
                const disabled = item.needsAnalytics && !analyticsReady
                const active = item.key === view
                if (disabled) {
                  return (
                    <span
                      key={item.key}
                      className="nav__link nav__link--disabled"
                      aria-disabled="true"
                      title="Add a position to see this view"
                    >
                      {item.label}
                    </span>
                  )
                }
                return (
                  <a
                    key={item.key}
                    className={active ? 'nav__link nav__link--active' : 'nav__link'}
                    href={`#/${item.key}`}
                    aria-current={active ? 'page' : undefined}
                  >
                    {item.label}
                    {item.key === 'holdings' ? (
                      <span className="nav__count num" aria-label={`${holdingsCount} positions`}>
                        {holdingsCount}
                      </span>
                    ) : null}
                  </a>
                )
              })}
            </div>
          )
        })}
        {indicator ? (
          <span
            className="nav__indicator"
            aria-hidden="true"
            style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
          />
        ) : null}
      </div>
    </nav>
  )
}
