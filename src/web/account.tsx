import { ChevronsUpDown, Lock, LogOut } from "lucide-react"
import { useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { Identity } from "./api.ts"

export const AccountMenu = ({
  me,
  onPassword,
  onSignOut,
}: {
  me: Identity
  onPassword: () => void
  onSignOut: () => void
}): React.JSX.Element => {
  const id = useId()
  const popup = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const initials = me.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join("")
    .toUpperCase()
  const choose = (action: () => void) => {
    popup.current?.hidePopover()
    action()
  }

  return (
    <>
      <button
        type="button"
        className="who"
        popoverTarget={id}
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Account options for ${me.name}`}
        onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (!popup.current) return
          const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 24)
          popup.current.style.width = `${width}px`
          popup.current.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`
          popup.current.style.top = rect.top > window.innerHeight / 2 ? "auto" : `${rect.bottom + 8}px`
          popup.current.style.bottom =
            rect.top > window.innerHeight / 2 ? `${window.innerHeight - rect.top + 8}px` : "auto"
        }}
      >
        <span className="avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="whodetails">
          <span className="whoname">{me.name}</span>
          <span className="whorole">{me.role}</span>
        </span>
        <ChevronsUpDown size={16} aria-hidden="true" />
      </button>
      {createPortal(
        <section
          id={id}
          ref={popup}
          popover="auto"
          className="accountmenu"
          aria-label="Account options"
          onToggle={event => setOpen(event.newState === "open")}
        >
          <button type="button" onClick={() => choose(onPassword)}>
            <Lock size={16} aria-hidden="true" />
            Change password
          </button>
          <button type="button" onClick={() => choose(onSignOut)}>
            <LogOut size={16} aria-hidden="true" />
            Sign out
          </button>
        </section>,
        document.body,
      )}
    </>
  )
}
