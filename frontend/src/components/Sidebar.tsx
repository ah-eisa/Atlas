/**
 * The navigation rail.
 *
 * Holds what used to be spread across the top of the page: the wordmark,
 * the portfolio switcher, the grouped views and the data source. It
 * collapses to a rail of icons (the choice is remembered), and on a phone it
 * becomes a drawer that slides in over the page.
 *
 * The current view is marked by an indicator that slides along the rail to
 * it - the motion answers the click and shows where you went. Up/Down (and
 * Home/End) move between views inside the rail; `[` and `]` anywhere else
 * step to the previous or next view; Ctrl+\ opens and closes the rail.
 */

import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

import { NAV_GROUPS } from '../lib/navigation'
import type { Portfolio } from '../lib/types'
import type { ViewKey } from '../lib/useHashRoute'
import { AtlasLogo } from './AtlasLogo'

/** 24px line icons, one per view. */
const ICONS: Record<ViewKey, string> = {
  overview: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z',
  performance: 'M3 17l6-6 4 4 8-8M14 7h7v7',
  risk: 'M12 3 2 20h20zM12 10v4M12 17h.01',
  xray: 'M9 3h6M10 3v6L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-10V3',
  projection: 'M3 20h18M5 16l4-5 3 3 6-8',
  holdings: 'M3 7h18v13H3zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  trades: 'M7 4v16M7 4 3 8M7 4l4 4M17 20V4M17 20l-4-4M17 20l4-4',
  bonds: 'M4 6h16v12H4zM4 10h16M8 14h3',
  macro: 'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  options: 'M4 20 20 4M8 4h12v12',
  data: 'M4 5c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
}

interface SidebarProps {
  view: ViewKey
  analyticsReady: boolean
  holdingsCount: number
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Phone drawer state; ignored on wider screens. */
  drawerOpen: boolean
  onCloseDrawer: () => void
  live: boolean
  portfolios: Portfolio[]
  activePortfolioId: number
  onSelectPortfolio?: (id: number) => void
  onCreatePortfolio?: () => void
  onSwitchSource?: () => void
  pricesAt?: string
}

export function Sidebar({
  view,
  analyticsReady,
  holdingsCount,
  collapsed,
  onToggleCollapsed,
  drawerOpen,
  onCloseDrawer,
  live,
  portfolios,
  activePortfolioId,
  onSelectPortfolio,
  onCreatePortfolio,
  onSwitchSource,
  pricesAt,
}: SidebarProps) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null)
  const active = portfolios.find((p) => p.id === activePortfolioId)

  const measure = useCallback(() => {
    const link = listRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
    setIndicator(link ? { top: link.offsetTop, height: link.offsetHeight } : null)
  }, [])

  useLayoutEffect(() => {
    measure()
  }, [view, analyticsReady, collapsed, measure])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    void document.fonts?.ready.then(measure)
    return () => observer.disconnect()
  }, [measure])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const keys = ['ArrowUp', 'ArrowDown', 'Home', 'End']
    if (!keys.includes(event.key)) return
    const links = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>('a.nav__link') ?? [])
    if (links.length === 0) return
    const current = links.indexOf(document.activeElement as HTMLAnchorElement)
    let next: number
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = links.length - 1
    else if (current < 0) next = links.findIndex((l) => l.getAttribute('aria-current') === 'page')
    else next = (current + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length
    event.preventDefault()
    links[Math.max(0, next)].focus()
  }

  const className = [
    'sidebar',
    collapsed ? 'sidebar--collapsed' : '',
    drawerOpen ? 'sidebar--drawer-open' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <div className="sidebar__scrim" onClick={onCloseDrawer} aria-hidden="true" />
      <aside className={className} aria-label="Navigation">
        <div className="sidebar__brand">
          <a className="sidebar__home" href="#/overview" aria-label="ATLAS, go to the overview">
            <AtlasLogo size={30} className="sidebar__logo" />
            <span className="sidebar__word">
              <strong>ATLAS</strong>
              <small>Private wealth</small>
            </span>
          </a>
          <button
            type="button"
            className="sidebar__toggle"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            aria-keyshortcuts="Control+Backslash"
            title={collapsed ? 'Expand the sidebar (Ctrl+\\)' : 'Collapse the sidebar (Ctrl+\\)'}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 3 5 8l5 5" />
            </svg>
          </button>
          <button type="button" className="sidebar__close" onClick={onCloseDrawer} aria-label="Close the menu">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M2 2 12 12 M12 2 2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {live && portfolios.length > 0 && onSelectPortfolio ? (
          <div className="sidebar__book">
            <span className="sidebar__book-mark" aria-hidden="true">
              {(active?.name ?? 'P').charAt(0).toUpperCase()}
            </span>
            <label className="sidebar__book-field">
              <span className="sidebar__book-label">Portfolio</span>
              <select
                className="sidebar__book-select"
                value={activePortfolioId}
                onChange={(e) => onSelectPortfolio(Number(e.target.value))}
              >
                {portfolios.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}, {p.base_currency}
                  </option>
                ))}
              </select>
            </label>
            {onCreatePortfolio ? (
              <button
                type="button"
                className="sidebar__book-add"
                onClick={onCreatePortfolio}
                aria-label="New portfolio"
                title="New portfolio"
              >
                <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            ) : null}
          </div>
        ) : null}

        <nav className="nav" aria-label="Primary" onKeyDown={onKeyDown}>
          <div className="nav__list" ref={listRef}>
            {NAV_GROUPS.map((group) => (
              <div key={group.label} className="nav__group" role="group" aria-label={group.label}>
                <span className="nav__group-label" aria-hidden="true">
                  {group.label}
                </span>
                {group.views.map((item) => {
                  const disabled = item.needsAnalytics && !analyticsReady
                  const current = item.key === view
                  const icon = (
                    <svg className="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d={ICONS[item.key]} />
                    </svg>
                  )
                  if (disabled) {
                    return (
                      <span
                        key={item.key}
                        className="nav__link nav__link--disabled"
                        aria-disabled="true"
                        data-tip={item.label}
                        title="Add a position to see this view"
                      >
                        {icon}
                        <span className="nav__label">{item.label}</span>
                      </span>
                    )
                  }
                  return (
                    <a
                      key={item.key}
                      className={current ? 'nav__link nav__link--active' : 'nav__link'}
                      href={`#/${item.key}`}
                      aria-current={current ? 'page' : undefined}
                      data-tip={item.label}
                      onClick={onCloseDrawer}
                    >
                      {icon}
                      <span className="nav__label">{item.label}</span>
                      {item.key === 'holdings' ? (
                        <span className="nav__count num" aria-label={`${holdingsCount} positions`}>
                          {holdingsCount}
                        </span>
                      ) : null}
                    </a>
                  )
                })}
              </div>
            ))}
            {indicator ? (
              <span
                className="nav__indicator"
                aria-hidden="true"
                style={{ transform: `translateY(${indicator.top}px)`, height: indicator.height }}
              />
            ) : null}
          </div>
        </nav>

        <button
          type="button"
          className="sidebar__source topbar__source"
          onClick={onSwitchSource}
          data-tip={live ? 'Live API' : 'Demo snapshot'}
          title={live ? 'Using the live API. Switch to the demo snapshot.' : 'Using the demo snapshot. Switch to the live API.'}
        >
          <span className={live ? 'sidebar__pulse' : 'sidebar__pulse sidebar__pulse--snapshot'} aria-hidden="true" />
          <span className="sidebar__source-text">
            <span>{live ? 'Live API' : 'Demo snapshot'}</span>
            {pricesAt ? <small>Prices {pricesAt}</small> : null}
          </span>
        </button>
      </aside>
    </>
  )
}
