import { useCallback, useEffect, useMemo, useRef } from "react"
import type { SharedPart } from "../../website/index.ts"

export type Selection = { field?: string; section?: string; shared?: string }

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
    [data-inkling-field]:focus-visible { outline: 3px solid #3d5afe; }
  `
  doc.head.append(style)
  return `<!doctype html>${doc.documentElement.outerHTML}`
}

export const Canvas = ({
  html,
  url,
  selected,
  onSelect,
  phone,
  labels,
  parts = [],
}: {
  html: string
  url: string
  selected: Selection
  onSelect: (selection: Selection) => void
  phone: boolean
  parts?: SharedPart[]
  labels: Record<string, string>
}) => {
  const frame = useRef<HTMLIFrameElement>(null)
  const scroll = useRef(0)
  const handler = useRef(onSelect)
  handler.current = onSelect
  const highlight = useCallback((selection: Selection, reveal = false) => {
    const doc = frame.current?.contentDocument
    if (!doc) return
    for (const el of doc.querySelectorAll("[data-inkling-selected]")) el.removeAttribute("data-inkling-selected")
    const attr = selection.shared
      ? "data-inkling-shared"
      : selection.field
        ? "data-inkling-field"
        : "data-inkling-section"
    const key = selection.shared ?? selection.field ?? selection.section
    const element = [...doc.querySelectorAll(`[${attr}]`)].find(el => el.getAttribute(attr) === key)
    element?.setAttribute("data-inkling-selected", "")
    if (reveal && element) element.scrollIntoView({ block: "nearest" })
  }, [])
  const source = useMemo(() => prepare(html, url, parts), [html, url, parts])
  useEffect(() => {
    highlight(selected, true)
  }, [selected, highlight])

  return (
    <iframe
      ref={frame}
      title="Page preview: select text or a picture to edit"
      className={phone ? "visualframe phone" : "visualframe"}
      sandbox="allow-same-origin"
      srcDoc={source}
      onLoad={() => {
        const doc = frame.current?.contentDocument
        const win = frame.current?.contentWindow
        if (!doc || !win) return
        win.scrollTo(0, scroll.current)
        win.addEventListener("scroll", () => {
          scroll.current = win.scrollY
        })
        const select = (target: EventTarget | null) => {
          const element = target as Element | null
          if (!element?.closest) return
          const field = element.closest("[data-inkling-field]")?.getAttribute("data-inkling-field") ?? undefined
          const section = element.closest("[data-inkling-section]")?.getAttribute("data-inkling-section") ?? undefined
          const shared = element.closest("[data-inkling-shared]")?.getAttribute("data-inkling-shared") ?? undefined
          if (field || section || shared) handler.current({ field, section, shared })
        }
        doc.addEventListener(
          "click",
          event => {
            event.preventDefault()
            event.stopPropagation()
            select(event.target)
          },
          true,
        )
        doc.addEventListener("submit", event => event.preventDefault(), true)
        doc.addEventListener("keydown", event => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          select(event.target)
        })
        for (const el of doc.querySelectorAll("[data-inkling-field], [data-inkling-shared]")) {
          el.setAttribute("tabindex", "0")
          el.setAttribute("role", "button")
          el.setAttribute(
            "aria-label",
            `Edit ${el.getAttribute("data-inkling-shared") ? el.getAttribute("data-inkling-label") : (labels[el.getAttribute("data-inkling-field") ?? ""] ?? "content")}`,
          )
        }
        highlight(selected)
      }}
    />
  )
}
