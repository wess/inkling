import { useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import "./style.css"

export type Point = { x: number; y: number }
export type ContextAction = { label: string; run: () => void; disabled?: boolean }

export const ContextMenu = ({
  title,
  anchor,
  actions,
  close,
}: {
  title: string
  anchor: Point
  actions: ContextAction[]
  close: (restore?: boolean) => void
}) => {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(anchor)
  useLayoutEffect(() => {
    const element = menu.current
    if (!element) return
    const bounds = element.getBoundingClientRect()
    setPosition({
      x: Math.max(8, Math.min(anchor.x, innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(anchor.y, innerHeight - bounds.height - 8)),
    })
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => {
      if (!element.contains(event.target as Node)) close(false)
    }
    const move = (event: Event) => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) close(false)
    }
    document.addEventListener("pointerdown", outside)
    window.addEventListener("resize", move)
    window.addEventListener("scroll", move, true)
    return () => {
      document.removeEventListener("pointerdown", outside)
      window.removeEventListener("resize", move)
      window.removeEventListener("scroll", move, true)
    }
  }, [anchor, close])
  return createPortal(
    <div
      ref={menu}
      className="contextmenu"
      role="menu"
      aria-label={title}
      style={{ left: position.x, top: position.y }}
      onKeyDown={event => {
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") event.preventDefault()
          close(event.key === "Escape")
          return
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
        event.preventDefault()
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])]
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        const index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
        items[index]?.focus()
      }}
    >
      <div className="contexttitle">{title}</div>
      {actions.map(action => (
        <button
          key={action.label}
          type="button"
          role="menuitem"
          disabled={action.disabled}
          onClick={() => {
            close(false)
            action.run()
          }}
        >
          {action.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
