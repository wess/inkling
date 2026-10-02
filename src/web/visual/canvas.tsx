import { MoreHorizontal } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { SharedPart } from "../../website/index.ts"
import { type ContextAction, ContextMenu, type Point } from "../context/index.tsx"
import { type Selection, selectedElement, selectionAt } from "./selection.ts"

export type { Selection } from "./selection.ts"

const NO_PARTS: SharedPart[] = []

const prepare = (html: string, url: string, parts: SharedPart[]): string => {
  const doc = new DOMParser().parseFromString(html, "text/html")
  for (const element of doc.querySelectorAll("script, iframe, object, embed, base, meta[http-equiv]")) element.remove()
  for (const element of doc.querySelectorAll("*")) {
    for (const attr of [...element.attributes]) {
      if (attr.name.startsWith("on") || attr.name === "autofocus") element.removeAttribute(attr.name)
    }
    for (const name of ["src", "href", "poster"]) {
      const value = element.getAttribute(name)
      if (value) {
        try {
          const resolved = new URL(value, url)
          if (["http:", "https:", "data:"].includes(resolved.protocol)) element.setAttribute(name, resolved.href)
          else element.removeAttribute(name)
        } catch {
          element.removeAttribute(name)
        }
      }
    }
  }
  for (const part of parts) {
    for (const el of doc.querySelectorAll(part.selector)) {
      el.setAttribute("data-inkling-shared", part.id)
      el.setAttribute("data-inkling-label", part.label)
    }
  }
  const style = doc.createElement("style")
  style.textContent = `
    html { scroll-behavior: auto !important; }
    [data-reveal] { opacity: 1 !important; transform: none !important; visibility: visible !important; }
    *, *::before, *::after { animation: none !important; transition: none !important; }
    [data-inkling-field], [data-inkling-section], [data-inkling-shared] { cursor: pointer; }
    [data-inkling-shared]:hover, [data-inkling-field]:hover { outline: 2px dashed #3d5afe; outline-offset: 3px; }
    [data-inkling-selected] { outline: 3px solid #3d5afe !important; outline-offset: -3px; }
    [data-inkling-hidden] { opacity: .4 !important; }
    [data-inkling-field]:focus-visible, [data-inkling-shared]:focus-visible, [data-inkling-section]:focus-visible { outline: 3px solid #3d5afe; }
  `
  doc.head.append(style)
  return `<!doctype html>${doc.documentElement.outerHTML}`
}

export const Canvas = ({
  html,
  url,
  selected,
  onSelect,
  onEdit = onSelect,
  onAsk,
  actions,
  phone,
  labels,
  parts = NO_PARTS,
}: {
  html: string
  url: string
  selected: Selection
  onSelect: (selection: Selection) => void
  onEdit?: (selection: Selection) => void
  onAsk?: (selection: Selection, anchor: () => DOMRect | null, restore: () => void) => void
  actions?: (selection: Selection) => ContextAction[]
  phone: boolean
  parts?: SharedPart[]
  labels: Record<string, string>
}) => {
  const frame = useRef<HTMLIFrameElement>(null)
  const scroll = useRef(0)
  const click = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [menu, setMenu] = useState<{ selection: Selection; anchor: Point } | null>(null)
  const [pointed, setPointed] = useState<Selection | null>(null)
  const handler = useRef({ onSelect, onEdit, onAsk, labels })
  handler.current = { onSelect, onEdit, onAsk, labels }
  const active = pointed ?? selected
  const nameOf = (selection: Selection) =>
    parts.find(part => part.id === selection.shared)?.label ??
    labels[selection.field ?? ""] ??
    labels[selection.section ?? ""] ??
    "Selected item"
  const highlight = useCallback((selection: Selection, reveal = false) => {
    const doc = frame.current?.contentDocument
    if (!doc) return
    for (const el of doc.querySelectorAll("[data-inkling-selected]")) el.removeAttribute("data-inkling-selected")
    const element = selectedElement(doc, selection)
    element?.setAttribute("data-inkling-selected", "")
    if (reveal && element && doc.defaultView) {
      const bounds = element.getBoundingClientRect()
      const height = doc.defaultView.innerHeight
      if (bounds.top < 0) doc.defaultView.scrollBy(0, bounds.top)
      else if (bounds.bottom > height) doc.defaultView.scrollBy(0, Math.min(bounds.top, bounds.bottom - height))
    }
  }, [])
  const source = useMemo(() => prepare(html, url, parts), [html, url, parts])
  useEffect(() => () => clearTimeout(click.current), [])
  useEffect(() => {
    setPointed(null)
    highlight({ field: selected.field, section: selected.section, shared: selected.shared }, true)
  }, [selected.field, selected.section, selected.shared, highlight])
  useEffect(() => {
    if (!pointed) highlight(selected)
  }, [pointed, selected, highlight])
  const anchorFor = (selection: Selection): DOMRect | null => {
    const iframe = frame.current
    const element = iframe?.contentDocument ? selectedElement(iframe.contentDocument, selection) : null
    if (!iframe || !element) return null
    const outer = iframe.getBoundingClientRect()
    const inner = element.getBoundingClientRect()
    return new DOMRect(outer.x + inner.x, outer.y + inner.y, inner.width, inner.height)
  }
  const close = useCallback((restore = false) => {
    setMenu(current => {
      if (restore && current && frame.current?.contentDocument)
        (selectedElement(frame.current.contentDocument, current.selection) as HTMLElement | undefined)?.focus()
      return null
    })
  }, [])
  const openMenu = (selection: Selection, anchor: Point) => {
    setPointed(selection)
    highlight(selection)
    setMenu({ selection, anchor })
  }

  return (
    <div className="visualsurface">
      <iframe
        ref={frame}
        title="Page preview: select text or a picture to edit"
        className={phone ? "visualframe phone" : "visualframe"}
        sandbox="allow-same-origin"
        srcDoc={source}
        onLoad={() => {
          clearTimeout(click.current)
          const doc = frame.current?.contentDocument
          const win = frame.current?.contentWindow
          if (!doc || !win) return
          win.scrollTo(0, scroll.current)
          window.dispatchEvent(new Event("inkling:canvasmove"))
          win.addEventListener("scroll", () => {
            scroll.current = win.scrollY
            setMenu(null)
            window.dispatchEvent(new Event("inkling:canvasmove"))
          })
          const select = (target: EventTarget | null, edit = false) => {
            const selection = selectionAt(target as Element | null)
            setMenu(null)
            setPointed(null)
            if (selection) {
              if (edit) handler.current.onEdit(selection)
              else handler.current.onSelect(selection)
            }
          }
          doc.addEventListener(
            "click",
            event => {
              event.preventDefault()
              event.stopPropagation()
              clearTimeout(click.current)
              if (selectionAt(event.target as Element | null)?.shared) {
                // switching shared controls can move the page before the second click
                click.current = setTimeout(() => select(event.target), 250)
              } else select(event.target)
            },
            true,
          )
          doc.addEventListener(
            "dblclick",
            event => {
              event.preventDefault()
              clearTimeout(click.current)
              select(event.target, true)
            },
            true,
          )
          doc.addEventListener("contextmenu", event => {
            clearTimeout(click.current)
            const selection = selectionAt(event.target as Element | null)
            if (!selection) return
            event.preventDefault()
            const outer = frame.current?.getBoundingClientRect()
            if (outer) openMenu(selection, { x: outer.x + event.clientX, y: outer.y + event.clientY })
          })
          doc.addEventListener("submit", event => event.preventDefault(), true)
          doc.addEventListener("keydown", event => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
              const selection = selectionAt(event.target as Element | null)
              const anchor = selection ? anchorFor(selection) : null
              if (selection && anchor) {
                event.preventDefault()
                openMenu(selection, { x: anchor.x, y: anchor.y })
              }
              return
            }
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            select(event.target, true)
          })
          for (const el of doc.querySelectorAll(
            "[data-inkling-field], [data-inkling-shared], [data-inkling-section]",
          )) {
            el.setAttribute("tabindex", "0")
            el.setAttribute("role", "button")
            el.setAttribute(
              "aria-label",
              `Edit ${el.getAttribute("data-inkling-shared") ? el.getAttribute("data-inkling-label") : (handler.current.labels[el.getAttribute("data-inkling-field") ?? ""] ?? el.getAttribute("data-inkling-label") ?? "content")}`,
            )
          }
          highlight(selected)
        }}
      />
      <button
        type="button"
        className="btn canvasactions"
        aria-label={`Actions for ${nameOf(active)}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={event => {
          const bounds = event.currentTarget.getBoundingClientRect()
          openMenu(active, { x: bounds.left, y: bounds.bottom })
        }}
      >
        <MoreHorizontal size={16} /> Actions
      </button>
      {menu ? (
        <ContextMenu
          title={nameOf(menu.selection)}
          anchor={menu.anchor}
          close={close}
          actions={[
            { label: `Edit ${nameOf(menu.selection).toLowerCase()}`, run: () => onEdit(menu.selection) },
            ...(onAsk
              ? [
                  {
                    label: "Ask Inky",
                    run: () =>
                      onAsk(
                        menu.selection,
                        () => anchorFor(menu.selection),
                        () => {
                          const doc = frame.current?.contentDocument
                          const element = doc
                            ? (selectedElement(doc, menu.selection) as HTMLElement | undefined)
                            : undefined
                          if (element) element.focus({ preventScroll: true })
                          else frame.current?.parentElement?.querySelector<HTMLButtonElement>(".canvasactions")?.focus()
                        },
                      ),
                  },
                ]
              : []),
            ...(actions?.(menu.selection) ?? []),
          ]}
        />
      ) : null}
    </div>
  )
}
