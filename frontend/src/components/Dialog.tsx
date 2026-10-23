/**
 * The one window every modal in the app is built from.
 *
 * It owns the behaviour a window must have and that each modal used to get
 * partly right on its own: Escape closes the topmost window only, Tab stays
 * inside it, focus moves into it on open and returns to whatever opened it on
 * close, and the page behind it does not scroll. On a phone it becomes a
 * bottom sheet.
 *
 * Forms pass `onSubmit`: the window itself becomes the <form>, so a submit
 * button in the footer works without any `form=` wiring.
 */

import { useId, useRef, type FormEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

import { useModalBehaviour } from '../lib/useModalBehaviour'

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** One plain sentence on what the window is for. */
  description?: ReactNode
  size?: DialogSize
  /** Footer actions, right-aligned; put the primary action last. */
  footer?: ReactNode
  /** Makes the window a form. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void
  /**
   * Whether a click on the backdrop closes the window. Off by default for
   * forms, so a stray click does not throw away what was typed.
   */
  closeOnBackdrop?: boolean
  /** Extra class on the panel, for windows with their own inner layout. */
  className?: string
  /** Element to focus on open; defaults to the first field in the body. */
  initialFocusRef?: RefObject<HTMLElement | null>
  children: ReactNode
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M2 2 12 12 M12 2 2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  onSubmit,
  closeOnBackdrop,
  className,
  initialFocusRef,
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  // A press that starts inside the panel and ends on the backdrop (selecting
  // text, dragging a slider) is not a click outside.
  const pressStartedOnBackdrop = useRef(false)

  useModalBehaviour(open, panelRef, onClose, initialFocusRef)

  if (!open) return null

  const dismissOnBackdrop = closeOnBackdrop ?? !onSubmit
  const panelClass = ['dialog', `dialog--${size}`, className].filter(Boolean).join(' ')
  const panelProps = {
    className: panelClass,
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': titleId,
    'aria-describedby': description ? descriptionId : undefined,
    tabIndex: -1,
  } as const

  const content = (
    <>
      <header className="dialog__header">
        <div className="dialog__heading">
          <h2 id={titleId} className="dialog__title">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="dialog__description">
              {description}
            </p>
          ) : null}
        </div>
        <button type="button" className="dialog__close" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </header>
      <div className="dialog__body">{children}</div>
      {footer ? <footer className="dialog__footer">{footer}</footer> : null}
    </>
  )

  return createPortal(
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        pressStartedOnBackdrop.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        if (dismissOnBackdrop && pressStartedOnBackdrop.current && event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      {onSubmit ? (
        <form
          {...panelProps}
          ref={(el) => {
            panelRef.current = el
          }}
          onSubmit={onSubmit}
        >
          {content}
        </form>
      ) : (
        <section
          {...panelProps}
          ref={(el) => {
            panelRef.current = el
          }}
        >
          {content}
        </section>
      )}
    </div>,
    document.body,
  )
}
