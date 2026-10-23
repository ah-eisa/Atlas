/**
 * A small dropdown of actions, for the toolbar buttons that do not fit on
 * narrower screens. Follows the menu-button pattern: Enter/Space or a click
 * opens it, arrow keys move, Escape or a click elsewhere closes it and
 * returns focus to the button.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export interface ActionMenuItem {
  key: string
  label: string
  onSelect: () => void
  /** Only listed on phones, where the toolbar button it stands in for is hidden. */
  phoneOnly?: boolean
}

interface ActionMenuProps {
  label: string
  items: ActionMenuItem[]
  className?: string
  children: ReactNode
}

export function ActionMenu({ label, items, className, children }: ActionMenuProps) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) buttonRef.current?.focus()
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    )
    const index = entries.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      entries[(index + step + entries.length) % entries.length]?.focus()
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      entries[event.key === 'Home' ? 0 : entries.length - 1]?.focus()
    } else if (event.key === 'Tab') {
      close(false)
    }
  }

  if (items.length === 0) return null

  return (
    <div className={['menu', className].filter(Boolean).join(' ')}>
      <button
        ref={buttonRef}
        type="button"
        className="button button--quiet button--sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {children}
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} className="menu__list" role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={item.phoneOnly ? 'menu__item menu__item--phone-only' : 'menu__item'}
              onClick={() => {
                close(false)
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
