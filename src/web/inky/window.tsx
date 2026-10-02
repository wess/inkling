import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import "./style.css"

export type ElementAnchor = () => DOMRect | null

export const InkyWindow = ({
  anchor,
  label,
  children,
}: {
  anchor?: ElementAnchor
  label: string
  children: ReactNode
}) => {
  const frame = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | undefined>()
  useLayoutEffect(() => {
    if (anchor) frame.current?.querySelector<HTMLButtonElement>("[data-inky-initial]")?.focus({ preventScroll: true })
  }, [anchor])
  useLayoutEffect(() => {
    const move = () => {
      const bounds = anchor?.()
      const panel = frame.current?.getBoundingClientRect()
      if (!bounds || !panel || innerWidth <= 720) {
        setPosition(undefined)
        return
      }
      const left = bounds.right + 12 + panel.width <= innerWidth ? bounds.right + 12 : bounds.left - panel.width - 12
      setPosition({
        left: Math.max(12, Math.min(left, innerWidth - panel.width - 12)),
        top: Math.max(12, Math.min(bounds.top, innerHeight - panel.height - 12)),
      })
    }
    move()
    const observer = new ResizeObserver(move)
    if (frame.current) observer.observe(frame.current)
    window.addEventListener("resize", move)
    window.addEventListener("scroll", move, true)
    window.addEventListener("inkling:canvasmove", move)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", move)
      window.removeEventListener("scroll", move, true)
      window.removeEventListener("inkling:canvasmove", move)
    }
  }, [anchor])
  return createPortal(
    <div
      ref={frame}
      className={anchor ? "dock elementinky" : "dock"}
      role="dialog"
      aria-label={label}
      style={position ? { ...position, right: "auto", bottom: "auto" } : undefined}
    >
      {children}
    </div>,
    document.body,
  )
}
