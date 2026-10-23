/**
 * Window behaviour without the window chrome: Escape closes the topmost
 * window only, Tab stays inside it, focus moves in on open and returns to
 * whatever opened it on close, and the page behind it does not scroll.
 *
 * Used by `Dialog`, and directly by the command palette, which draws its own
 * panel.
 */

import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

// Open windows, innermost last. Escape and scroll locking act on this stack,
// so a trade window opened from the watchlist closes on its own.
const openStack: symbol[] = []

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && el.offsetParent !== null,
  )
}

export function useModalBehaviour(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const token = Symbol('dialog')
    openStack.push(token)
    const previouslyFocused = document.activeElement as HTMLElement | null
    if (openStack.length === 1) document.body.classList.add('has-modal')

    // Focus at once, so keys typed straight after opening are not lost; the
    // panel is already in the DOM when this effect runs.
    const focusInitial = () => {
      const panel = panelRef.current
      if (!panel) return false
      const target =
        initialFocusRef?.current ??
        panel.querySelector<HTMLElement>('[data-autofocus]') ??
        panel.querySelector<HTMLElement>('.dialog__body input, .dialog__body select, .dialog__body textarea') ??
        panel
      target.focus({ preventScroll: true })
      return true
    }
    const frame = focusInitial() ? 0 : window.requestAnimationFrame(focusInitial)

    const onKeyDown = (event: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== token) return
      const panel = panelRef.current
      if (!panel) return

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const items = focusableIn(panel)
      if (items.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown, true)
      const index = openStack.indexOf(token)
      if (index >= 0) openStack.splice(index, 1)
      if (openStack.length === 0) document.body.classList.remove('has-modal')
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true })
      }
    }
  }, [open, panelRef, initialFocusRef])
}
