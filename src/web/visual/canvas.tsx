import { MoreHorizontal } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { SharedPart } from "../../website/index.ts"
import { type ContextAction, ContextMenu, type Point } from "../context/index.tsx"
import { prepare } from "./prepare.ts"
import { type FrameRect, readRect, readSelection, selectionKey } from "./protocol.ts"
import type { Selection } from "./selection.ts"

export type { Selection } from "./selection.ts"

const NO_PARTS: SharedPart[] = []

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
  const bounds = useRef(new Map<string, FrameRect>())
  const [revision, setRevision] = useState(0)
  const [status, setStatus] = useState("loading")
  const [menu, setMenu] = useState<{ selection: Selection; anchor: Point } | null>(null)
  const [pointed, setPointed] = useState<Selection | null>(null)
  const handler = useRef({ onSelect, onEdit, labels, parts, selected })
  handler.current = { onSelect, onEdit, labels, parts, selected }
  const active = pointed ?? selected
  const document = useMemo(
    () => ({ html, url, parts, channel: `${revision}:${crypto.randomUUID()}` }),
    [html, url, parts, revision],
  )
  const source = useMemo(
    () => prepare(document.html, document.url, document.parts, document.channel, location.origin),
    [document],
  )
  const channel = useRef(document.channel)
  channel.current = document.channel
  const post = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ ...message, channel: channel.current }, "*")
  }, [])
  const nameOf = (selection: Selection) =>
    parts.find(part => part.id === selection.shared)?.label ??
    labels[selection.field ?? ""] ??
    labels[selection.section ?? ""] ??
    "Selected item"
  const highlight = useCallback(
    (selection: Selection, reveal = false) => post({ kind: "highlight", selection, reveal }),
    [post],
  )
  const initialize = useCallback(
    () =>
      post({
        kind: "init",
        selection: handler.current.selected,
        labels: handler.current.labels,
        scroll: scroll.current,
      }),
    [post],
  )

  useLayoutEffect(() => {
    bounds.current.clear()
    setStatus("loading")
    setMenu(null)
    const timeout = setTimeout(() => setStatus("failed"), 5000)
    const receive = (event: MessageEvent) => {
      const value = event.data
      if (event.source !== frame.current?.contentWindow || !value || value.channel !== document.channel) return
      if (value.kind === "ready") {
        clearTimeout(timeout)
        setStatus("ready")
        initialize()
        return
      }
      if (value.kind === "shortcut" && ["s", "z"].includes(value.key)) {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: value.key,
            metaKey: value.metaKey === true,
            ctrlKey: value.ctrlKey === true,
            shiftKey: value.shiftKey === true,
          }),
        )
        return
      }
      if (value.kind === "scroll") {
        setMenu(null)
        return
      }
      const { labels, parts } = handler.current
      const ids = parts.map(part => part.id)
      if (value.kind === "geometry" && Array.isArray(value.items)) {
        const next = new Map<string, FrameRect>()
        for (const item of value.items.slice(0, 2000)) {
          const selection = readSelection(item?.selection, ids, labels)
          const rect = readRect(item?.rect)
          if (selection && rect && !next.has(selectionKey(selection))) next.set(selectionKey(selection), rect)
        }
        bounds.current = next
        if (typeof value.scroll === "number" && Number.isFinite(value.scroll))
          scroll.current = Math.max(0, value.scroll)
        window.dispatchEvent(new Event("inkling:canvasmove"))
        return
      }
      const selection = readSelection(value.selection, ids, labels)
      if (!selection) return
      if (value.kind === "menu") {
        if (![value.x, value.y].every(value => typeof value === "number" && Number.isFinite(value))) return
        const outer = frame.current?.getBoundingClientRect()
        if (!outer) return
        setPointed(selection)
        highlight(selection)
        setMenu({ selection, anchor: { x: outer.x + value.x, y: outer.y + value.y } })
      } else if (value.kind === "select" || value.kind === "edit") {
        setMenu(null)
        setPointed(null)
        if (value.kind === "edit") handler.current.onEdit(selection)
        else handler.current.onSelect(selection)
      }
    }
    window.addEventListener("message", receive)
    return () => {
      clearTimeout(timeout)
      window.removeEventListener("message", receive)
    }
  }, [document.channel, initialize, highlight])
  useEffect(() => {
    setPointed(null)
    highlight({ field: selected.field, section: selected.section, shared: selected.shared }, true)
  }, [selected.field, selected.section, selected.shared, highlight])
  useEffect(() => {
    if (!pointed) highlight(selected)
  }, [pointed, selected, highlight])
  const anchorFor = (selection: Selection): DOMRect | null => {
    const outer = frame.current?.getBoundingClientRect()
    const inner = bounds.current.get(selectionKey(selection))
    return outer && inner ? new DOMRect(outer.x + inner.x, outer.y + inner.y, inner.width, inner.height) : null
  }
  const restore = (selection: Selection) => {
    if (frame.current && bounds.current.has(selectionKey(selection))) post({ kind: "focus", selection })
    else {
      const fallback =
        frame.current?.parentElement?.querySelector<HTMLButtonElement>(".canvasactions") ??
        window.document.querySelector<HTMLButtonElement>(".dockbubble")
      fallback?.focus({ preventScroll: true })
    }
  }
  const close = useCallback(
    (focus = false) => {
      setMenu(current => {
        if (focus && current) post({ kind: "focus", selection: current.selection })
        return null
      })
    },
    [post],
  )

  return (
    <div className="visualsurface">
      <iframe
        ref={frame}
        title="Page preview: select text or a picture to edit"
        className={phone ? "visualframe phone" : "visualframe"}
        sandbox="allow-scripts"
        srcDoc={source}
        onLoad={initialize}
      />
      {status !== "ready" ? (
        <div className="canvasmessage" role={status === "failed" ? "alert" : "status"}>
          {status === "failed" ? (
            <>
              Preview controls could not start.{" "}
              <button type="button" className="btn" onClick={() => setRevision(value => value + 1)}>
                Reload preview
              </button>
            </>
          ) : (
            "Starting preview controls…"
          )}
        </div>
      ) : null}
      <button
        type="button"
        className="btn canvasactions"
        aria-label={`Actions for ${nameOf(active)}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={event => {
          const bounds = event.currentTarget.getBoundingClientRect()
          setPointed(active)
          highlight(active)
          setMenu({ selection: active, anchor: { x: bounds.left, y: bounds.bottom } })
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
                        () => restore(menu.selection),
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
