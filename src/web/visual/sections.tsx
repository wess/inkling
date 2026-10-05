import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical } from "lucide-react"
import { useRef, useState } from "react"
import type { VisualPage } from "../api.ts"
import { reorderSections } from "./order.ts"

export const Sections = ({
  sections,
  hidden,
  disabled,
  select,
  reorder,
  toggle,
}: {
  sections: VisualPage["sections"]
  hidden: string[]
  disabled: boolean
  select: (id: string) => void
  reorder: (order: string[]) => void
  toggle: (id: string) => void
}) => {
  const dragging = useRef<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [message, setMessage] = useState("")
  const clear = () => {
    dragging.current = null
    setOver(null)
  }
  const move = (from: string, to: string) => {
    if (disabled) return
    const order = reorderSections(sections, from, to)
    if (!order) return
    reorder(order)
    setMessage(`${sections.find(section => section.id === from)?.label} moved to position ${order.indexOf(from) + 1}.`)
  }
  return (
    <>
      <p className="dim2">Drag a section by its handle, or use the arrows to move it.</p>
      <span className="visualannouncement" role="status">
        {message}
      </span>
      <ol className="visualsections">
        {sections.map((item, index) => (
          <li
            key={item.id}
            className={over === item.id ? "droptarget" : ""}
            onDragOver={event => {
              if (disabled || !dragging.current || !reorderSections(sections, dragging.current, item.id)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = "move"
              setOver(item.id)
            }}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null)
            }}
            onDrop={event => {
              event.preventDefault()
              if (dragging.current) move(dragging.current, item.id)
              clear()
            }}
          >
            <span
              role="img"
              className="visualgrip"
              aria-label={`Drag ${item.label} to reorder; use the move arrows for keyboard controls`}
              aria-disabled={disabled || item.movable === false}
              draggable={!disabled && item.movable !== false}
              onDragStart={event => {
                if (disabled || item.movable === false) {
                  event.preventDefault()
                  return
                }
                dragging.current = item.id
                event.dataTransfer.effectAllowed = "move"
                event.dataTransfer.setData("text/plain", item.id)
              }}
              onDragEnd={clear}
            >
              <GripVertical size={16} />
            </span>
            <button type="button" className="visualsectionname" onClick={() => select(item.id)}>
              {item.label}
              <small>{hidden.includes(item.id) ? "Hidden from visitors" : "Visible"}</small>
            </button>
            <div className="row">
              <button
                type="button"
                className="btn ghost sm"
                aria-label={`Move ${item.label} up`}
                disabled={disabled || !reorderSections(sections, item.id, sections[index - 1]?.id ?? "")}
                onClick={() => move(item.id, sections[index - 1]?.id ?? "")}
              >
                <ArrowUp size={15} />
              </button>
              <button
                type="button"
                className="btn ghost sm"
                aria-label={`Move ${item.label} down`}
                disabled={disabled || !reorderSections(sections, item.id, sections[index + 1]?.id ?? "")}
                onClick={() => move(item.id, sections[index + 1]?.id ?? "")}
              >
                <ArrowDown size={15} />
              </button>
              <button
                type="button"
                className="btn ghost sm"
                aria-label={`${hidden.includes(item.id) ? "Show" : "Hide"} ${item.label}`}
                disabled={disabled}
                onClick={() => toggle(item.id)}
              >
                {hidden.includes(item.id) ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </li>
        ))}
      </ol>
    </>
  )
}
