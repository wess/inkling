import {
  Activity,
  ArrowDown,
  ArrowUp,
  Blocks,
  Bold,
  Check,
  ChevronLeft,
  Copy,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Inbox,
  Italic,
  Key,
  LayoutGrid,
  Link,
  List,
  ListOrdered,
  ListTree,
  Lock,
  LogOut,
  Maximize2,
  Menu as MenuIcon,
  Minimize2,
  Minus,
  Pencil,
  Plus,
  Quote,
  Redo2,
  RotateCcw,
  Search,
  Send,
  Settings,
  Shapes,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Users,
  Webhook as WebhookIcon,
  X,
} from "lucide-react"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type {
  AgentProposal,
  AiCredential,
  AiProvider,
  AuditEvent,
  ContentType,
  Entry,
  Field,
  Identity,
  Media,
  MenuItem,
  Plugin,
  PluginPanel,
  PluginStatsPayload,
  Stats,
  Taxonomy,
  Term,
  Webhook,
} from "./api.ts"
import { api, clearToken, getToken, runAgent, setToken } from "./api.ts"

// Single-file admin SPA, following the same convention as the rest of the
// stack: hooks only, no component classes, no router dependency. Routing is a
// small hash-free history reader — the admin has ~10 screens and a router
// library would be more surface than the thing it routes.

// ---------------------------------------------------------------- utilities

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ")

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part[0] ?? "")
    .join("")
    .toUpperCase()

const ROLE_RANK: Record<string, number> = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 }
const hasRole = (role: string, minimum: "author" | "editor" | "admin" | "owner"): boolean =>
  (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[minimum] ?? 99)

const ago = (iso: string | null): string => {
  if (!iso) return "—"
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

const localDateTime = (date = new Date()): string =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)

const previewUrl = (template: string | null, entry: Entry, type: ContentType, siteUrl: string): string | null => {
  if (!template) return null
  const rendered = template
    .replaceAll("{id}", encodeURIComponent(entry.id))
    .replaceAll("{locale}", encodeURIComponent(entry.locale))
    .replaceAll("{slug}", encodeURIComponent(entry.slug))
    .replaceAll("{type}", encodeURIComponent(type.name))
  try {
    return new URL(rendered, siteUrl || undefined).toString()
  } catch {
    return null
  }
}

const bytes = (size: number): string => {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

const temporaryPassword = (): string => {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const random = crypto.getRandomValues(new Uint8Array(16))
  return `A7!${[...random].map(value => alphabet[value % alphabet.length]).join("")}z`
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : "Something went wrong")

// Field errors come back as { details: { fields: [{key, message}] } } so the
// editor can mark the specific inputs rather than showing one banner.
const fieldErrors = (error: unknown): Record<string, string> => {
  const details = (error as { details?: { fields?: { key: string; message: string }[] } })?.details
  return Object.fromEntries((details?.fields ?? []).map(f => [f.key, f.message]))
}

const useUnsavedWarning = (dirty: boolean): void => {
  useEffect(() => {
    document.body.dataset.unsaved = dirty ? "true" : "false"
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return
      event.preventDefault()
    }
    addEventListener("beforeunload", beforeUnload)
    return () => {
      delete document.body.dataset.unsaved
      removeEventListener("beforeunload", beforeUnload)
    }
  }, [dirty])
}

// ---------------------------------------------------------------- routing

type Route =
  | { name: "dashboard" }
  | { name: "activity" }
  | { name: "collection"; type: string }
  | { name: "editor"; type: string; id: string | null }
  | { name: "media" }
  | { name: "types"; type?: string }
  | { name: "taxonomy" }
  | { name: "menus" }
  | { name: "trash" }
  | { name: "webhooks" }
  | { name: "plugins" }
  | { name: "plugin"; plugin: string; panel: string }
  | { name: "settings" }
  | { name: "keys" }
  | { name: "users" }
  | { name: "ai" }

// Where the admin is mounted, injected by src/web/serve.ts. Empty when Inkling
// owns the origin; "/admin" or similar when a site does. Every route the SPA
// reads or writes is relative to it.
const BASE: string = (window as Window & { __INKLING_BASE__?: string }).__INKLING_BASE__ ?? ""

const relative = (pathname: string): string =>
  BASE && pathname.startsWith(BASE) ? pathname.slice(BASE.length) || "/" : pathname

const parse = (path: string): Route => {
  const [, head, a, b] = relative(path).split("/")
  if (head === "c" && a)
    return b ? { name: "editor", type: a, id: b === "new" ? null : b } : { name: "collection", type: a }
  if (head === "media") return { name: "media" }
  if (head === "activity") return { name: "activity" }
  if (head === "types") return { name: "types", type: a }
  if (head === "taxonomy") return { name: "taxonomy" }
  if (head === "menus") return { name: "menus" }
  if (head === "trash") return { name: "trash" }
  if (head === "webhooks") return { name: "webhooks" }
  if (head === "plugins") return a && b ? { name: "plugin", plugin: a, panel: b } : { name: "plugins" }
  if (head === "settings") return { name: "settings" }
  if (head === "keys") return { name: "keys" }
  if (head === "users") return { name: "users" }
  if (head === "ai") return { name: "ai" }
  return { name: "dashboard" }
}

const href = (route: Route): string => {
  switch (route.name) {
    case "collection":
      return `/c/${route.type}`
    case "editor":
      return `/c/${route.type}/${route.id ?? "new"}`
    case "plugin":
      return `/plugins/${route.plugin}/${route.panel}`
    case "types":
      return route.type ? `/types/${route.type}` : "/types"
    case "dashboard":
      return "/"
    default:
      return `/${route.name}`
  }
}

const useRoute = (): [Route, (route: Route) => void] => {
  const [path, setPath] = useState(location.pathname)

  useEffect(() => {
    const onPop = () => setPath(location.pathname)
    addEventListener("popstate", onPop)
    return () => removeEventListener("popstate", onPop)
  }, [])

  const go = useCallback((route: Route) => {
    if (document.body.dataset.unsaved === "true") {
      if (!confirm("Leave without saving your changes?")) return
      delete document.body.dataset.unsaved
    }
    const next = `${BASE}${href(route)}`
    history.pushState({}, "", next)
    setPath(next)
    scrollTo(0, 0)
  }, [])

  return [useMemo(() => parse(path), [path]), go]
}

// ---------------------------------------------------------------- primitives

const Spinner = () => (
  <div className="loading">
    <div className="spin" />
  </div>
)

const Note = ({ kind, children }: { kind: "err" | "ok" | "info" | "warn"; children: React.ReactNode }) => (
  <div className={`note ${kind}`}>{children}</div>
)

const Pill = ({ status }: { status: string }) => <span className={`pill ${status}`}>{status}</span>

const Modal = ({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  wide?: boolean
}) => {
  const dialog = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const focusable = () =>
      [
        ...(dialog.current?.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]") ?? []),
      ].filter(element => !element.hasAttribute("disabled") && element.tabIndex >= 0)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
      if (event.key !== "Tab") return
      const controls = focusable()
      const first = controls[0]
      const last = controls.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    addEventListener("keydown", onKey)
    focusable()[0]?.focus()
    return () => {
      removeEventListener("keydown", onKey)
      previous?.focus()
    }
  }, [onClose])

  return (
    <div className="scrim">
      {/* Clicking outside closes; Escape is handled above. A button rather than
          a div with onClick so it is reachable by keyboard and assistive tech. */}
      <button type="button" className="scrimhit" aria-label="Close" onClick={onClose} />
      <div ref={dialog} className={cx("modal", wide && "lg")} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modalhead">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn ghost sm rowend" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="modalbody">{children}</div>
        {footer ? <div className="modalfoot">{footer}</div> : null}
      </div>
    </div>
  )
}

const Empty = ({ title, hint, action }: { title: string; hint: string; action?: React.ReactNode }) => (
  <div className="empty">
    <h3>{title}</h3>
    <p>{hint}</p>
    {action}
  </div>
)

// ---------------------------------------------------------------- media picker

const MediaPicker = ({
  value,
  multiple,
  onPick,
  onClose,
}: {
  value: string | string[] | null
  multiple: boolean
  onPick: (value: string | string[] | null) => void
  onClose: () => void
}) => {
  const [items, setItems] = useState<Media[]>([])
  const [busy, setBusy] = useState(true)
  const [chosen, setChosen] = useState<string[]>(
    Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [],
  )
  const [q, setQ] = useState("")
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  const load = useCallback(() => {
    setBusy(true)
    api
      .media({ limit: 48, page, q })
      .then(result => {
        setItems(result.data)
        setTotal(result.meta.total)
      })
      .finally(() => setBusy(false))
  }, [page, q])

  useEffect(load, [load])

  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    for (const file of Array.from(files)) await api.uploadMedia(file).catch(() => {})
    load()
  }

  const toggle = (id: string) =>
    setChosen(current =>
      multiple
        ? current.includes(id)
          ? current.filter(x => x !== id)
          : [...current, id]
        : current[0] === id
          ? []
          : [id],
    )

  return (
    <Modal
      wide
      title={multiple ? "Choose images" : "Choose an image"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              onPick(multiple ? chosen : (chosen[0] ?? null))
              onClose()
            }}
          >
            {multiple ? `Use ${chosen.length} selected` : "Use image"}
          </button>
        </>
      }
    >
      <label className="drop" style={{ display: "block", marginBottom: 16 }}>
        <input type="file" multiple hidden onChange={event => upload(event.target.files)} accept="image/*" />
        <Upload size={19} style={{ marginBottom: 6 }} />
        <div style={{ fontSize: 13 }}>Click to upload</div>
      </label>

      <div className="search" style={{ width: "100%", maxWidth: "none", marginBottom: 14 }}>
        <Search size={14} />
        <input
          type="search"
          placeholder="Search files…"
          value={q}
          onChange={event => {
            setQ(event.target.value)
            setPage(1)
          }}
        />
      </div>

      {busy ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Empty title="No media yet" hint="Upload something to get started." />
      ) : (
        <>
          <div className="mediagrid">
            {items.map(item => (
              <button
                type="button"
                key={item.id}
                className={cx("mediatile", chosen.includes(item.id) && "sel")}
                onClick={() => toggle(item.id)}
                style={{ padding: 0, font: "inherit", textAlign: "left" }}
              >
                <div className="mediathumb">
                  {item.mime.startsWith("image/") ? (
                    <img src={item.url} alt={item.alt ?? item.filename} loading="lazy" />
                  ) : (
                    <FileText size={22} />
                  )}
                </div>
                <div className="medianame">{item.filename}</div>
              </button>
            ))}
          </div>
          {total > 48 ? (
            <div className="pager mediapager">
              <span>
                {(page - 1) * 48 + 1}–{Math.min(page * 48, total)} of {total}
              </span>
              <div className="rowend">
                <button type="button" className="btn sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                  Previous
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={page * 48 >= total}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------- field inputs

const MediaField = ({
  value,
  multiple,
  onChange,
}: {
  value: unknown
  multiple: boolean
  onChange: (value: unknown) => void
}) => {
  const [picking, setPicking] = useState(false)
  const [resolved, setResolved] = useState<Media[]>([])
  const ids = useMemo(
    () => (multiple ? ((value as string[]) ?? []) : value ? [value as string] : []),
    [value, multiple],
  )

  useEffect(() => {
    if (ids.length === 0) {
      setResolved([])
      return
    }
    // The editor stores ids; fetch just enough to show a thumbnail. The
    // delivery API expands these server-side, so this is admin-only work.
    void Promise.all(ids.map(mediaId => api.mediaItem(mediaId).catch(() => null))).then(items =>
      setResolved(items.filter((item): item is Media => item !== null)),
    )
  }, [ids])

  return (
    <>
      <div className="stack">
        {resolved.map(item => (
          <div className="mediapick" key={item.id}>
            {item.mime.startsWith("image/") ? (
              <img className="thumb" src={item.url} alt={item.alt ?? ""} />
            ) : (
              <div className="thumb" style={{ display: "grid", placeItems: "center" }}>
                <FileText size={17} />
              </div>
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 550, overflow: "hidden", textOverflow: "ellipsis" }}>
                {item.filename}
              </div>
              <div className="dim2">{bytes(item.size)}</div>
            </div>
            <button
              type="button"
              className="btn ghost sm rowend"
              onClick={() => onChange(multiple ? ids.filter(x => x !== item.id) : null)}
              aria-label="Remove"
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button type="button" className="btn" onClick={() => setPicking(true)} style={{ alignSelf: "flex-start" }}>
          <ImageIcon size={14} /> {ids.length > 0 && !multiple ? "Replace" : "Choose"}
        </button>
      </div>
      {picking ? (
        <MediaPicker
          value={(value as string | string[] | null) ?? null}
          multiple={multiple}
          onPick={onChange}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </>
  )
}

const ReferenceField = ({
  field,
  value,
  onChange,
}: {
  field: Field
  value: unknown
  onChange: (value: unknown) => void
}) => {
  const [entries, setEntries] = useState<Entry[]>([])
  const [busy, setBusy] = useState(true)
  const [q, setQ] = useState("")
  const multiple = field.multiple === true || Array.isArray(value)
  const chosen = useMemo(
    () => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []),
    [value],
  )

  useEffect(() => {
    if (!field.of) {
      setBusy(false)
      return
    }
    setBusy(true)
    api
      .entries(field.of, { limit: 50, q })
      .then(async result => {
        const selectedIds = multiple ? chosen : typeof value === "string" && value ? [value] : []
        const missing = selectedIds.filter(entryId => !result.data.some(entry => entry.id === entryId))
        const selected = await Promise.all(missing.map(entryId => api.entry(entryId).catch(() => null)))
        setEntries([...selected.filter((entry): entry is Entry => entry !== null), ...result.data])
      })
      .catch(() => setEntries([]))
      .finally(() => setBusy(false))
  }, [field.of, multiple, q, chosen, value])

  if (!field.of) return <Note kind="warn">Choose a content type for this field in the content model.</Note>

  if (multiple) {
    return (
      <div className="referencepicker">
        <input
          type="search"
          aria-label={`Search ${field.label}`}
          placeholder="Search by title…"
          value={q}
          onChange={event => setQ(event.target.value)}
        />
        <div className="referencechoices">
          {busy ? <span className="dim2">Loading…</span> : null}
          {!busy && entries.length === 0 ? <span className="dim2">No matching entries.</span> : null}
          {entries.map(entry => (
            <label className="check" key={entry.id}>
              <input
                type="checkbox"
                checked={chosen.includes(entry.id)}
                onChange={() =>
                  onChange(chosen.includes(entry.id) ? chosen.filter(id => id !== entry.id) : [...chosen, entry.id])
                }
              />
              <span>{entry.title || "Untitled"}</span>
            </label>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="referencepicker">
      <input
        type="search"
        aria-label={`Search ${field.label}`}
        placeholder="Search by title…"
        value={q}
        onChange={event => setQ(event.target.value)}
      />
      <select
        value={typeof value === "string" ? value : ""}
        disabled={busy}
        onChange={event => onChange(event.target.value || null)}
      >
        <option value="">{busy ? "Loading…" : "Nothing selected"}</option>
        {entries.map(entry => (
          <option key={entry.id} value={entry.id}>
            {entry.title || "Untitled"}
          </option>
        ))}
      </select>
    </div>
  )
}

const RICH_TAGS = new Set([
  "A",
  "B",
  "BLOCKQUOTE",
  "BR",
  "DIV",
  "EM",
  "FIGCAPTION",
  "FIGURE",
  "H2",
  "H3",
  "H4",
  "HR",
  "I",
  "IMG",
  "LI",
  "OL",
  "P",
  "STRONG",
  "U",
  "UL",
])

// Media filenames and alt text are user-supplied, and both end up inside an
// HTML string handed to execCommand — so they are escaped on the way in rather
// than trusted to be tag-free.
const escapeText = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const escapeAttribute = (value: string): string => escapeText(value).replace(/"/g, "&quot;")

const safeRichUrl = (value: string): string | null => {
  const url = value.trim()
  if (url.startsWith("/") || url.startsWith("#")) return url
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:" ? url : null
  } catch {
    return null
  }
}

const sanitizeRichHtml = (value: string): string => {
  const document = new DOMParser().parseFromString(value, "text/html")
  for (const element of document.body.querySelectorAll("script, style, iframe, object, embed, svg, math")) {
    element.remove()
  }
  for (const element of document.body.querySelectorAll("*")) {
    if (!RICH_TAGS.has(element.tagName)) {
      element.replaceWith(...element.childNodes)
      continue
    }
    const href = element.tagName === "A" ? safeRichUrl(element.getAttribute("href") ?? "") : null
    // An inline image is the one element whose attributes carry its meaning, so
    // src and alt are read before the wipe and put back afterwards.
    const source = element.tagName === "IMG" ? safeRichUrl(element.getAttribute("src") ?? "") : null
    const alt = element.tagName === "IMG" ? (element.getAttribute("alt") ?? "") : ""

    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name)

    if (element.tagName === "A" && href) {
      element.setAttribute("href", href)
      if (href.startsWith("http")) {
        element.setAttribute("target", "_blank")
        element.setAttribute("rel", "noreferrer")
      }
    }
    if (element.tagName === "IMG") {
      if (!source) {
        element.remove()
        continue
      }
      element.setAttribute("src", source)
      element.setAttribute("alt", alt)
    }
  }
  return document.body.innerHTML
}

const RichTextInput = ({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
}) => {
  const editor = useRef<HTMLDivElement>(null)
  const selection = useRef<Range | null>(null)
  // Where an image will land, as the index of the top-level block the caret was
  // in. A Range cannot be used: it is a live object, so when this element's
  // content is re-rendered while the picker holds focus, every saved range —
  // clone or not — collapses to the start and the image lands at the top of the
  // post. An index survives that, because the blocks come back in order.
  const insertAfter = useRef<number | null>(null)
  const [linkUrl, setLinkUrl] = useState("")
  const [picking, setPicking] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const [counts, setCounts] = useState({ words: 0, minutes: 0 })

  const measure = useCallback((html: string) => {
    const words = html
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .split(/\s+/)
      .filter(Boolean).length
    setCounts({ words, minutes: Math.max(1, Math.round(words / 200)) })
  }, [])

  useEffect(() => {
    const node = editor.current
    if (!node || node === document.activeElement) return
    const clean = sanitizeRichHtml(value)
    if (node.innerHTML !== clean) node.innerHTML = clean
    measure(clean)
  }, [value, measure])

  const rememberSelection = () => {
    const node = editor.current
    // Same focus guard as the listener below — a selection the editor does not
    // own is not a caret worth remembering.
    if (!node || document.activeElement !== node) return
    const current = window.getSelection()
    if (current?.rangeCount && node.contains(current.anchorNode)) {
      selection.current = current.getRangeAt(0).cloneRange()
    }
  }

  // Discrete handlers miss the ways a caret can move, so the caret is tracked
  // continuously instead. The focus check is the load-bearing part: when the
  // media dialog takes focus the browser leaves a collapsed selection at the
  // start of this element, which still looks like a caret "inside the editor".
  // Capturing that overwrites the writer's real position and the image lands at
  // the top of the post. Only a selection this element actually owns counts.
  useEffect(() => {
    const capture = () => {
      const node = editor.current
      if (!node || document.activeElement !== node) return
      const current = window.getSelection()
      if (current?.rangeCount && node.contains(current.anchorNode)) {
        selection.current = current.getRangeAt(0).cloneRange()
      }
    }
    document.addEventListener("selectionchange", capture)
    return () => document.removeEventListener("selectionchange", capture)
  }, [])

  const sync = () => {
    if (!editor.current) return
    onChange(editor.current.innerHTML)
    measure(editor.current.innerHTML)
    rememberSelection()
  }

  const command = (name: string, argument?: string) => {
    editor.current?.focus()
    document.execCommand(name, false, argument)
    sync()
  }

  // Restores the caret the toolbar stole before inserting at it. Safe for
  // toolbar actions that never leave the page; anything that opens a dialog
  // must remember a block index instead, since a Range does not survive the
  // editor re-rendering. A stale range is worse than none — its nodes may have
  // been replaced — so it is checked against the live DOM, and anything
  // unusable appends to the end rather than landing at the top of the post.
  const insertAtCaret = (html: string) => {
    const node = editor.current
    if (!node) return
    node.focus()

    const current = window.getSelection()
    current?.removeAllRanges()

    const stored = selection.current
    if (stored && node.contains(stored.commonAncestorContainer)) {
      current?.addRange(stored)
    } else {
      const end = document.createRange()
      end.selectNodeContents(node)
      end.collapse(false)
      current?.addRange(end)
    }

    document.execCommand("insertHTML", false, html)
    sync()
  }

  const addLink = () => {
    const href = safeRichUrl(linkUrl)
    if (!href || !selection.current) return
    const current = window.getSelection()
    current?.removeAllRanges()
    current?.addRange(selection.current)
    command("createLink", href)
    setLinkUrl("")
  }

  // The index of the top-level block holding the caret, or null when the caret
  // is not in this editor.
  const caretBlock = (): number | null => {
    const node = editor.current
    const stored = selection.current
    if (!node || !stored || !node.contains(stored.startContainer)) return null

    let block: Node | null = stored.startContainer
    while (block && block.parentNode !== node) block = block.parentNode
    if (!block) return null
    return [...node.childNodes].indexOf(block as ChildNode)
  }

  const addImage = async (picked: string | string[] | null) => {
    const after = insertAfter.current
    insertAfter.current = null
    setPicking(false)

    const mediaId = Array.isArray(picked) ? picked[0] : picked
    if (!mediaId) return
    const item = await api.mediaItem(mediaId).catch(() => null)
    if (!item?.mime.startsWith("image/")) return

    const node = editor.current
    if (!node) return

    // The saved range is gone by now, but the block index survived — so a fresh
    // range is built from it and handed to execCommand. Going through the
    // browser's own editing command is what keeps the insert on the undo stack;
    // writing the nodes in by hand would put it beyond the reach of ⌘Z.
    node.focus()
    const range = document.createRange()
    // With an anchor the caret goes just after it; without one it falls to the
    // end of the post, which is why the collapse direction differs.
    const anchor = after === null ? null : node.childNodes[after]
    if (anchor) range.setStartAfter(anchor)
    else range.selectNodeContents(node)
    range.collapse(Boolean(anchor))

    const current = window.getSelection()
    current?.removeAllRanges()
    current?.addRange(range)

    const alt = escapeAttribute(item.alt ?? "")
    const caption = item.alt ? `<figcaption>${escapeText(item.alt)}</figcaption>` : ""
    // A paragraph after it, so there is somewhere to keep writing.
    document.execCommand(
      "insertHTML",
      false,
      `<figure><img src="${escapeAttribute(item.url)}" alt="${alt}" />${caption}</figure><p><br /></p>`,
    )
    sync()
  }

  const tool = (label: string, icon: React.ReactNode, name: string, argument?: string) => (
    <button
      type="button"
      className="richtool"
      aria-label={label}
      title={label}
      onMouseDown={event => {
        event.preventDefault()
        command(name, argument)
      }}
    >
      {icon}
    </button>
  )

  return (
    <div className={cx("richeditor", focusMode && "focusmode")}>
      <div className="richtools" role="toolbar" aria-label="Text formatting">
        {tool("Paragraph", <span className="richletter">P</span>, "formatBlock", "p")}
        {tool("Heading", <span className="richletter">H2</span>, "formatBlock", "h2")}
        {tool("Subheading", <span className="richletter">H3</span>, "formatBlock", "h3")}
        {tool("Minor heading", <span className="richletter">H4</span>, "formatBlock", "h4")}
        <span className="richdivide" aria-hidden="true" />
        {tool("Bold", <Bold size={14} />, "bold")}
        {tool("Italic", <Italic size={14} />, "italic")}
        {tool("Bulleted list", <List size={14} />, "insertUnorderedList")}
        {tool("Numbered list", <ListOrdered size={14} />, "insertOrderedList")}
        {tool("Quote", <Quote size={14} />, "formatBlock", "blockquote")}
        <span className="richdivide" aria-hidden="true" />
        <button
          type="button"
          className="richtool"
          aria-label="Insert image"
          title="Insert image"
          onMouseDown={event => {
            event.preventDefault()
            rememberSelection()
            insertAfter.current = caretBlock()
            setPicking(true)
          }}
        >
          <ImageIcon size={14} />
        </button>
        <button
          type="button"
          className="richtool"
          aria-label="Insert a divider"
          title="Insert a divider"
          onMouseDown={event => {
            event.preventDefault()
            insertAtCaret("<hr /><p><br /></p>")
          }}
        >
          <Minus size={14} />
        </button>
        <span className="richdivide" aria-hidden="true" />
        {tool("Undo", <Undo2 size={14} />, "undo")}
        {tool("Redo", <Redo2 size={14} />, "redo")}
        <span className="richlink">
          <input
            type="url"
            aria-label="Link URL"
            placeholder="Paste a link"
            value={linkUrl}
            onChange={event => setLinkUrl(event.target.value)}
            onFocus={rememberSelection}
            onKeyDown={event => {
              if (event.key === "Enter") {
                event.preventDefault()
                addLink()
              }
            }}
          />
          <button type="button" className="richtool" disabled={!safeRichUrl(linkUrl)} onClick={addLink}>
            <Link size={14} /> <span className="sr">Add link to selected text</span>
          </button>
        </span>
        <button
          type="button"
          className="richtool rowend"
          aria-label={focusMode ? "Leave focus mode" : "Focus mode"}
          aria-pressed={focusMode}
          title={focusMode ? "Leave focus mode" : "Focus mode"}
          onMouseDown={event => {
            event.preventDefault()
            setFocusMode(current => !current)
          }}
        >
          {focusMode ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>
      {/* A textarea cannot expose browser rich-text editing commands. */}
      {/* biome-ignore lint/a11y/useSemanticElements: contenteditable is the semantic editing surface here */}
      <div
        id={id}
        ref={editor}
        className="richcontent"
        contentEditable
        role="textbox"
        tabIndex={0}
        aria-label={label}
        aria-multiline="true"
        data-placeholder="Start writing…"
        suppressContentEditableWarning
        onInput={sync}
        onMouseUp={rememberSelection}
        onKeyUp={rememberSelection}
        onKeyDown={event => {
          // Escape is the way out of focus mode without reaching for the mouse.
          if (event.key === "Escape" && focusMode) {
            event.preventDefault()
            setFocusMode(false)
          }
        }}
        onPaste={event => {
          event.preventDefault()
          document.execCommand("insertText", false, event.clipboardData.getData("text/plain"))
          sync()
        }}
        onBlur={() => {
          if (!editor.current) return
          const clean = sanitizeRichHtml(editor.current.innerHTML)
          editor.current.innerHTML = clean
          onChange(clean)
          measure(clean)
        }}
      />
      <div className="richfoot">
        <span className="richhint">Select text before adding a link. Pasted content is cleaned automatically.</span>
        <span className="richcount">
          {counts.words.toLocaleString()} {counts.words === 1 ? "word" : "words"} · {counts.minutes} min read
        </span>
      </div>
      {picking ? (
        <MediaPicker value={null} multiple={false} onPick={addImage} onClose={() => setPicking(false)} />
      ) : null}
    </div>
  )
}

const FieldInput = ({
  field,
  value,
  error,
  onChange,
}: {
  field: Field
  value: unknown
  error?: string
  onChange: (value: unknown) => void
}) => {
  const common = { id: `f-${field.key}`, "aria-label": field.label }

  const input = (() => {
    switch (field.type) {
      case "textarea":
      case "markdown":
        return (
          <textarea
            {...common}
            value={(value as string) ?? ""}
            rows={field.type === "textarea" ? 4 : 12}
            onChange={event => onChange(event.target.value)}
          />
        )

      case "richtext":
        return <RichTextInput id={common.id} label={field.label} value={(value as string) ?? ""} onChange={onChange} />

      case "number":
        return (
          <input
            {...common}
            type="number"
            value={value === null || value === undefined ? "" : String(value)}
            min={field.min}
            max={field.max}
            onChange={event => onChange(event.target.value === "" ? null : Number(event.target.value))}
          />
        )

      case "boolean":
        return (
          <label className="check">
            <input
              type="checkbox"
              aria-label={field.label}
              checked={value === true}
              onChange={event => onChange(event.target.checked)}
            />
            <span>{field.help ?? "Enabled"}</span>
          </label>
        )

      case "date":
        return (
          <input {...common} type="date" value={(value as string) ?? ""} onChange={e => onChange(e.target.value)} />
        )

      case "datetime":
        return (
          <input
            {...common}
            type="datetime-local"
            value={value ? String(value).slice(0, 16) : ""}
            onChange={event => onChange(event.target.value ? new Date(event.target.value).toISOString() : null)}
          />
        )

      case "select":
        return (
          <select {...common} value={(value as string) ?? ""} onChange={event => onChange(event.target.value)}>
            <option value="">—</option>
            {(field.options ?? []).map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )

      case "multiselect":
        return (
          <div className="wrap">
            {(field.options ?? []).map(option => {
              const list = (value as string[]) ?? []
              const on = list.includes(option.value)
              return (
                <button
                  type="button"
                  key={option.value}
                  className={cx("btn sm", on && "primary")}
                  onClick={() => onChange(on ? list.filter(x => x !== option.value) : [...list, option.value])}
                >
                  {on ? <Check size={12} /> : null}
                  {option.label}
                </button>
              )
            })}
          </div>
        )

      case "media":
        return <MediaField value={value} multiple={false} onChange={onChange} />

      case "gallery":
        return <MediaField value={value} multiple onChange={onChange} />

      case "reference":
        return <ReferenceField field={field} value={value} onChange={onChange} />

      case "color":
        return (
          <div className="row">
            <input
              type="color"
              value={(value as string) || "#000000"}
              onChange={event => onChange(event.target.value)}
              style={{ width: 42, height: 34, padding: 2, cursor: "pointer" }}
            />
            <input type="text" value={(value as string) ?? ""} onChange={event => onChange(event.target.value)} />
          </div>
        )

      case "json":
        return (
          <textarea
            {...common}
            className="mono"
            rows={6}
            value={typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2)}
            onChange={event => onChange(event.target.value)}
          />
        )

      case "list":
        return <ListField field={field} value={value} onChange={onChange} />

      default:
        return (
          <input
            {...common}
            type={field.type === "email" ? "email" : field.type === "url" ? "text" : "text"}
            value={(value as string) ?? ""}
            onChange={event => onChange(event.target.value)}
          />
        )
    }
  })()

  return (
    <fieldset className="f">
      <legend className="fl">
        {field.label}
        {field.required ? <span className="req">*</span> : null}
      </legend>
      {input}
      {error ? (
        <span className="fh" style={{ color: "var(--bad)" }}>
          {error}
        </span>
      ) : null}
      {!error && field.help && field.type !== "boolean" ? <span className="fh">{field.help}</span> : null}
    </fieldset>
  )
}

const ListField = ({
  field,
  value,
  onChange,
}: {
  field: Field
  value: unknown
  onChange: (value: unknown) => void
}) => {
  const rows = (value as Record<string, unknown>[]) ?? []
  const nested = field.fields ?? []

  const update = (index: number, key: string, next: unknown) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, [key]: next } : row)))

  return (
    <div className="repeater">
      {rows.map((row, index) => (
        // Repeater rows have no stable identity, so the index is the key. Rows
        // are only ever appended or removed whole, never reordered in place.
        // biome-ignore lint/suspicious/noArrayIndexKey: rows carry no id
        <div className="repeatrow" key={index}>
          <div className="repeathead">
            <span className="repeatnum">#{index + 1}</span>
            <button
              type="button"
              className="btn ghost sm rowend"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
              aria-label="Remove row"
            >
              <Trash2 size={13} />
            </button>
          </div>
          {nested.map(sub => (
            <FieldInput
              key={sub.key}
              field={sub}
              value={row[sub.key]}
              onChange={next => update(index, sub.key, next)}
            />
          ))}
        </div>
      ))}
      <div style={{ padding: 11 }}>
        <button type="button" className="btn sm" onClick={() => onChange([...rows, {}])}>
          <Plus size={13} /> Add row
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- screens

const Dashboard = ({ go }: { go: (route: Route) => void }) => {
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    api
      .stats()
      .then(setStats)
      .catch(() => {})
  }, [])

  if (!stats) return <Spinner />

  const tiles = [
    { label: "Entries", value: stats.entries },
    { label: "Published", value: stats.published },
    { label: "Needs review", value: stats.review },
    { label: "Scheduled", value: stats.scheduled },
    { label: "Drafts", value: stats.drafts },
    { label: "Media", value: stats.media },
  ]

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 20 }}>
        {tiles.map(tile => (
          <div className="card stat" key={tile.label}>
            <div className="statnum">{tile.value}</div>
            <div className="statlabel">{tile.label}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="cardhead">
          <h2>Recently edited</h2>
        </div>
        {stats.recent.length === 0 ? (
          <Empty title="Nothing here yet" hint="Content you create will show up here." />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Type</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {stats.recent.map(row => (
                <tr key={row.id}>
                  <td>
                    <button
                      type="button"
                      className="tablelink"
                      onClick={() => go({ name: "editor", type: row.type, id: row.id })}
                    >
                      {row.title || "Untitled"}
                    </button>
                  </td>
                  <td className="dim">{row.type}</td>
                  <td>
                    <Pill status={row.status} />
                  </td>
                  <td className="dim2">{ago(row.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

const Collection = ({ type, canWrite, go }: { type: ContentType; canWrite: boolean; go: (route: Route) => void }) => {
  const [entries, setEntries] = useState<Entry[]>([])
  const [busy, setBusy] = useState(true)
  const [status, setStatus] = useState("all")
  const [q, setQ] = useState("")
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    setBusy(true)
    api
      .entries(type.name, { status, q, limit: 50, page })
      .then(result => {
        setEntries(result.data)
        setTotal(result.meta.total)
      })
      .finally(() => setBusy(false))
  }, [type.name, status, q, page])

  // A single-entry type has no list worth showing — go straight to its editor.
  useEffect(() => {
    if (type.kind === "single" && !busy) {
      go({ name: "editor", type: type.name, id: entries[0]?.id ?? null })
    }
  }, [type.kind, type.name, busy, entries, go])

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <h1>{type.pluralLabel}</h1>
          {type.description ? <p className="dim2">{type.description}</p> : null}
        </div>
        <div className="rowend">
          <div className="search">
            <Search size={14} />
            <input
              type="search"
              placeholder="Search titles…"
              value={q}
              onChange={event => {
                setQ(event.target.value)
                setPage(1)
              }}
            />
          </div>
          <select
            value={status}
            onChange={event => {
              setStatus(event.target.value)
              setPage(1)
            }}
            style={{ width: 132 }}
          >
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="review">In review</option>
            <option value="scheduled">Scheduled</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
          {canWrite ? (
            <button
              type="button"
              className="btn primary"
              onClick={() => go({ name: "editor", type: type.name, id: null })}
            >
              <Plus size={14} /> New
            </button>
          ) : null}
        </div>
      </div>

      <div className="card">
        {busy ? (
          <Spinner />
        ) : entries.length === 0 ? (
          <Empty
            title={`No ${type.pluralLabel.toLowerCase()} yet`}
            hint={`Create the first ${type.label.toLowerCase()}.`}
            action={
              canWrite ? (
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => go({ name: "editor", type: type.name, id: null })}
                >
                  <Plus size={14} /> New {type.label.toLowerCase()}
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th style={{ width: 200 }}>Slug</th>
                    <th style={{ width: 110 }}>Status</th>
                    <th style={{ width: 120 }}>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(entry => (
                    <tr key={entry.id}>
                      <td>
                        <button
                          type="button"
                          className="tablelink"
                          onClick={() => go({ name: "editor", type: type.name, id: entry.id })}
                        >
                          {entry.title || "Untitled"}
                        </button>
                      </td>
                      <td className="mono dim">{entry.slug}</td>
                      <td>
                        <Pill status={entry.status} />
                      </td>
                      <td className="dim2">{ago(entry.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {total > 50 ? (
              <div className="pager">
                <span>
                  {(page - 1) * 50 + 1}–{Math.min(page * 50, total)} of {total}
                </span>
                <div className="rowend">
                  <button type="button" className="btn sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                    Previous
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={page * 50 >= total}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  )
}

const EntryTaxonomies = ({
  entryId,
  canEdit,
  toast,
}: {
  entryId: string
  canEdit: boolean
  toast: (message: string, bad?: boolean) => void
}) => {
  const [taxonomies, setTaxonomies] = useState<Taxonomy[]>([])
  const [terms, setTerms] = useState<Term[]>([])
  const [selected, setSelected] = useState<string[]>([])

  useEffect(() => {
    void Promise.all([api.taxonomies(), api.entryTerms(entryId)]).then(async ([groups, attached]) => {
      setTaxonomies(groups)
      setSelected(attached.map(term => term.id))
      const lists = await Promise.all(groups.map(group => api.terms(group.name)))
      setTerms(lists.flat())
    })
  }, [entryId])

  if (taxonomies.length === 0 || terms.length === 0) return null

  const toggle = async (termId: string) => {
    const previous = selected
    const next = selected.includes(termId) ? selected.filter(id => id !== termId) : [...selected, termId]
    setSelected(next)
    try {
      await api.setEntryTerms(entryId, next)
    } catch (error) {
      setSelected(previous)
      toast(errorOf(error), true)
    }
  }

  return (
    <div className="card">
      <div className="cardhead">
        <h3>Categories</h3>
      </div>
      <div className="cardbody taxonomychecks">
        {taxonomies.map(group => {
          const choices = terms.filter(term => term.taxonomyId === group.id)
          if (choices.length === 0) return null
          return (
            <fieldset key={group.id}>
              <legend>{group.label}</legend>
              {choices.map(term => (
                <label className="check" key={term.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(term.id)}
                    disabled={!canEdit}
                    onChange={() => void toggle(term.id)}
                  />
                  <span>{term.label}</span>
                </label>
              ))}
            </fieldset>
          )
        })}
      </div>
    </div>
  )
}

const Editor = ({
  type,
  id,
  canEdit,
  canPublish,
  identityId,
  go,
  toast,
}: {
  type: ContentType
  id: string | null
  canEdit: boolean
  canPublish: boolean
  identityId: string
  go: (route: Route) => void
  toast: (message: string, bad?: boolean) => void
}) => {
  const [entry, setEntry] = useState<Entry | null>(null)
  const [title, setTitle] = useState("")
  const [slug, setSlug] = useState("")
  const [locale, setLocale] = useState("en")
  const [sortOrder, setSortOrder] = useState(0)
  const [data, setData] = useState<Record<string, unknown>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [scheduleAt, setScheduleAt] = useState("")
  const [siteUrl, setSiteUrl] = useState("")
  const [writers, setWriters] = useState<Identity[]>([])
  const mayEdit = canEdit && (!entry || canPublish || entry.authorId === identityId)

  // Only an editor may reassign a byline, so only an editor needs the roster.
  useEffect(() => {
    if (!canPublish) return
    api
      .users()
      .then(result => setWriters(result.data))
      .catch(() => {})
  }, [canPublish])

  useEffect(() => {
    if (!type.previewUrl?.startsWith("/")) return
    api
      .settings()
      .then(result => setSiteUrl(typeof result.data.url === "string" ? result.data.url : ""))
      .catch(() => {})
  }, [type.previewUrl])

  useEffect(() => {
    if (!id) {
      setEntry(null)
      setTitle("")
      setSlug("")
      setLocale("en")
      setSortOrder(0)
      setData(Object.fromEntries(type.fields.map(f => [f.key, f.default ?? null])))
      setBusy(false)
      return
    }
    setBusy(true)
    api
      .entry(id)
      .then(row => {
        setEntry(row)
        setTitle(row.title)
        setSlug(row.slug)
        setLocale(row.locale)
        setSortOrder(row.sortOrder)
        setData(row.data)
      })
      .catch(error => toast(errorOf(error), true))
      .finally(() => setBusy(false))
  }, [id, type.fields, toast])

  const edit = (key: string, value: unknown) => {
    setData(current => ({ ...current, [key]: value }))
    setDirty(true)
    setErrors(current => {
      if (!current[key]) return current
      const { [key]: _, ...rest } = current
      return rest
    })
  }

  const save = async (): Promise<Entry | null> => {
    setSaving(true)
    setErrors({})
    try {
      const payload = {
        title: title || "Untitled",
        slug: slug || slugify(title) || undefined,
        locale,
        sortOrder,
        data,
      }
      const saved = entry ? await api.updateEntry(entry.id, payload) : await api.createEntry(type.name, payload)
      setEntry(saved)
      setSlug(saved.slug)
      setDirty(false)
      delete document.body.dataset.unsaved
      toast("Saved")
      if (!entry) go({ name: "editor", type: type.name, id: saved.id })
      return saved
    } catch (error) {
      const fields = fieldErrors(error)
      setErrors(fields)
      toast(Object.keys(fields).length > 0 ? "Some fields need attention" : errorOf(error), true)
    } finally {
      setSaving(false)
    }
    return null
  }

  const setStatus = async (publish: boolean) => {
    if (!entry) return
    try {
      const target = dirty ? await save() : entry
      if (!target) return
      const updated = publish ? await api.publishEntry(target.id) : await api.unpublishEntry(target.id)
      setEntry(updated)
      toast(publish ? "Published" : "Moved to draft")
    } catch (error) {
      toast(errorOf(error), true)
    }
  }

  const schedule = async () => {
    if (!entry || !scheduleAt) return
    try {
      const target = dirty ? await save() : entry
      if (!target) return
      const updated = await api.publishEntry(target.id, new Date(scheduleAt).toISOString())
      setEntry(updated)
      setScheduleAt("")
      toast("Scheduled")
    } catch (error) {
      toast(errorOf(error), true)
    }
  }

  const remove = async () => {
    if (!entry || !confirm(`Move "${entry.title || "Untitled"}" to trash?`)) return
    await api.deleteEntry(entry.id).catch(error => toast(errorOf(error), true))
    go({ name: "collection", type: type.name })
  }

  // Cmd/Ctrl-S is the reflex in every editor; intercept it rather than letting
  // the browser open a save-page dialog over the admin.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (mayEdit && (event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault()
        void save()
      }
    }
    addEventListener("keydown", onKey)
    return () => removeEventListener("keydown", onKey)
  })

  useUnsavedWarning(dirty)

  if (busy) return <Spinner />

  const liveUrl = entry?.status === "published" ? previewUrl(type.previewUrl, entry, type, siteUrl) : null

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <button type="button" className="btn ghost sm" onClick={() => go({ name: "collection", type: type.name })}>
          <ChevronLeft size={15} /> {type.pluralLabel}
        </button>
        <div className="rowend">
          {entry ? <Pill status={entry.status} /> : <span className="pill">new</span>}
          {mayEdit ? (
            <button type="button" className="btn primary" onClick={save} disabled={saving || (!dirty && !!entry)}>
              {saving ? <span className="spin" /> : null}
              {saving ? "Saving" : dirty || !entry ? "Save" : "Saved"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="editor">
        <fieldset className="editorset" disabled={!mayEdit}>
          <div className="card">
            <div className="cardbody">
              <input
                className="titleinput"
                placeholder={`${type.label} title`}
                value={title}
                onChange={event => {
                  setTitle(event.target.value)
                  setDirty(true)
                  if (!entry) setSlug(slugify(event.target.value))
                }}
              />
              <div className="slugline">
                <span>/</span>
                <input
                  value={slug}
                  placeholder="slug"
                  onChange={event => {
                    setSlug(event.target.value)
                    setDirty(true)
                  }}
                />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="cardbody">
              {type.fields.length === 0 ? (
                <Empty title="No fields defined" hint={`Add fields to "${type.label}" to start capturing content.`} />
              ) : (
                type.fields.map(field => (
                  <FieldInput
                    key={field.key}
                    field={field}
                    value={data[field.key]}
                    error={errors[field.key]}
                    onChange={value => edit(field.key, value)}
                  />
                ))
              )}
            </div>
          </div>
        </fieldset>

        <div className="rail">
          <div className="card">
            <div className="cardhead">
              <h3>Publishing</h3>
            </div>
            <div className="cardbody stack">
              {entry ? (
                <>
                  <div className="dim2">
                    Created {ago(entry.createdAt)}
                    <br />
                    Updated {ago(entry.updatedAt)}
                    {entry.publishedAt ? (
                      <>
                        <br />
                        Published {ago(entry.publishedAt)}
                      </>
                    ) : null}
                  </div>
                  {canPublish && writers.length > 0 ? (
                    <label className="field">
                      <span className="fl">Credited to</span>
                      <select
                        value={entry.authorId ?? ""}
                        onChange={async event => {
                          try {
                            setEntry(await api.updateEntry(entry.id, { authorId: event.target.value || null }))
                            toast("Byline updated")
                          } catch (error) {
                            toast(errorOf(error), true)
                          }
                        }}
                      >
                        <option value="">Nobody</option>
                        {writers.map(writer => (
                          <option key={writer.id} value={writer.id}>
                            {writer.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {liveUrl ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => window.open(liveUrl, "_blank", "noopener,noreferrer")}
                    >
                      <ExternalLink size={14} /> View live
                    </button>
                  ) : null}
                  {mayEdit ? (
                    canPublish && entry.status === "published" ? (
                      <button type="button" className="btn" onClick={() => setStatus(false)}>
                        Move to draft
                      </button>
                    ) : canPublish ? (
                      <>
                        <button type="button" className="btn primary" onClick={() => setStatus(true)}>
                          Publish now
                        </button>
                        <details className="schedulebox">
                          <summary>Schedule for later</summary>
                          <label className="f">
                            <span className="fl">Publish at</span>
                            <input
                              type="datetime-local"
                              value={scheduleAt}
                              min={localDateTime()}
                              onChange={event => setScheduleAt(event.target.value)}
                            />
                          </label>
                          <button type="button" className="btn" disabled={!scheduleAt} onClick={() => void schedule()}>
                            Schedule
                          </button>
                        </details>
                        {entry.status !== "review" ? (
                          <button
                            type="button"
                            className="btn"
                            onClick={async () => {
                              try {
                                const target = dirty ? await save() : entry
                                if (!target) return
                                setEntry(await api.setEntryStatus(target.id, "review"))
                                toast("Sent for review")
                              } catch (error) {
                                toast(errorOf(error), true)
                              }
                            }}
                          >
                            Send for review
                          </button>
                        ) : null}
                      </>
                    ) : entry.status !== "review" ? (
                      <button
                        type="button"
                        className="btn primary"
                        onClick={async () => {
                          try {
                            const target = dirty ? await save() : entry
                            if (!target) return
                            setEntry(await api.setEntryStatus(target.id, "review"))
                            toast("Sent for review")
                          } catch (error) {
                            toast(errorOf(error), true)
                          }
                        }}
                      >
                        Send for review
                      </button>
                    ) : (
                      <Note kind="info">This is waiting for an editor to review it.</Note>
                    )
                  ) : (
                    <Note kind="info">
                      {canEdit
                        ? "You can view this entry, but only its author or an editor can change it."
                        : "Your role has read-only access."}
                    </Note>
                  )}
                  {mayEdit ? (
                    <button type="button" className="btn danger" onClick={remove}>
                      <Trash2 size={14} /> Move to trash
                    </button>
                  ) : null}
                </>
              ) : (
                <p className="dim2">Save this {type.label.toLowerCase()} before publishing it.</p>
              )}
            </div>
          </div>

          <div className="card">
            <div className="cardhead">
              <h3>Details</h3>
            </div>
            <div className="cardbody">
              <label className="f">
                <span className="fl">Language</span>
                <input
                  type="text"
                  value={locale}
                  disabled={!mayEdit}
                  placeholder="en"
                  onChange={event => {
                    setLocale(event.target.value)
                    setDirty(true)
                  }}
                />
                <span className="fh">A language code such as en or es-MX.</span>
              </label>
              <label className="f" style={{ marginBottom: 0 }}>
                <span className="fl">Display order</span>
                <input
                  type="number"
                  value={sortOrder}
                  disabled={!mayEdit}
                  onChange={event => {
                    setSortOrder(Number(event.target.value) || 0)
                    setDirty(true)
                  }}
                />
                <span className="fh">Lower numbers appear first when a site sorts by display order.</span>
              </label>
            </div>
          </div>

          {entry ? <EntryTaxonomies entryId={entry.id} canEdit={mayEdit} toast={toast} /> : null}
          {entry ? (
            <Revisions
              entry={entry}
              fields={type.fields}
              canRestore={mayEdit}
              toast={toast}
              onRestore={() => location.reload()}
            />
          ) : null}
        </div>
      </div>
    </>
  )
}

const Revisions = ({
  entry,
  fields,
  canRestore,
  toast,
  onRestore,
}: {
  entry: Entry
  fields: Field[]
  canRestore: boolean
  toast: (message: string, bad?: boolean) => void
  onRestore: () => void
}) => {
  const [items, setItems] = useState<
    { id: string; title: string; authorName: string | null; note: string | null; createdAt: string }[]
  >([])
  const [viewing, setViewing] = useState<Awaited<ReturnType<typeof api.revision>> | null>(null)

  useEffect(() => {
    api
      .revisions(entry.id)
      .then(setItems)
      .catch(() => {})
  }, [entry.id])

  if (items.length === 0) return null

  return (
    <div className="card">
      <div className="cardhead">
        <h3>History</h3>
      </div>
      <div className="cardbody stack" style={{ gap: 9 }}>
        {items.slice(0, 8).map(item => (
          <div className="row" key={item.id} style={{ alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5 }}>{item.note ?? "Edited"}</div>
              <div className="dim2">
                {ago(item.createdAt)}
                {item.authorName ? ` · ${item.authorName}` : ""}
              </div>
            </div>
            <div className="rowend">
              <button
                type="button"
                className="btn ghost sm"
                onClick={() =>
                  void api
                    .revision(item.id)
                    .then(setViewing)
                    .catch(error => toast(errorOf(error), true))
                }
              >
                View
              </button>
              {canRestore ? (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={async () => {
                    if (!confirm("Restore this version? The current one is saved to history first.")) return
                    try {
                      await api.restoreRevision(item.id)
                      onRestore()
                    } catch (error) {
                      toast(errorOf(error), true)
                    }
                  }}
                >
                  Restore
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {viewing ? (
        <Modal title={`Version from ${new Date(viewing.createdAt).toLocaleString()}`} onClose={() => setViewing(null)}>
          <div className="revisionmeta">
            <span className="pill">{viewing.status}</span>
            <strong>{viewing.title || "Untitled"}</strong>
          </div>
          {fields.map(field => {
            const before = viewing.data[field.key]
            const current = entry.data[field.key]
            const changed = JSON.stringify(before) !== JSON.stringify(current)
            return (
              <div className={cx("revisionfield", changed && "changed")} key={field.key}>
                <div className="row">
                  <strong>{field.label}</strong>
                  {changed ? <span className="pill review rowend">changed</span> : null}
                </div>
                <pre>{typeof before === "string" ? before : JSON.stringify(before ?? null, null, 2)}</pre>
              </div>
            )
          })}
        </Modal>
      ) : null}
    </div>
  )
}

const MediaLibrary = ({
  canManage,
  toast,
}: {
  canManage: boolean
  toast: (message: string, bad?: boolean) => void
}) => {
  const [items, setItems] = useState<Media[]>([])
  const [busy, setBusy] = useState(true)
  const [over, setOver] = useState(false)
  const [active, setActive] = useState<Media | null>(null)
  const [q, setQ] = useState("")
  const [type, setType] = useState("")
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const filePicker = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    setBusy(true)
    api
      .media({ limit: 60, page, q, type })
      .then(result => {
        setItems(result.data)
        setTotal(result.meta.total)
      })
      .finally(() => setBusy(false))
  }, [page, q, type])

  useEffect(load, [load])

  const upload = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return
    setBusy(true)
    for (const file of Array.from(files)) {
      await api.uploadMedia(file).catch(error => toast(errorOf(error), true))
    }
    load()
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <h1>Media</h1>
        <div className="rowend">
          <div className="search">
            <Search size={14} />
            <input
              type="search"
              placeholder="Search files…"
              value={q}
              onChange={event => {
                setQ(event.target.value)
                setPage(1)
              }}
            />
          </div>
          <select
            aria-label="File type"
            value={type}
            style={{ width: 125 }}
            onChange={event => {
              setType(event.target.value)
              setPage(1)
            }}
          >
            <option value="">All files</option>
            <option value="image">Images</option>
            <option value="video">Videos</option>
            <option value="audio">Audio</option>
          </select>
          {canManage ? (
            <label className="btn primary">
              <Upload size={14} /> Upload
              <input ref={filePicker} type="file" multiple hidden onChange={event => upload(event.target.files)} />
            </label>
          ) : null}
        </div>
      </div>

      {canManage ? (
        <button
          type="button"
          className={cx("drop", over && "over")}
          style={{ marginBottom: 18, width: "100%", font: "inherit" }}
          onDragOver={event => {
            event.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={event => {
            event.preventDefault()
            setOver(false)
            void upload(event.dataTransfer.files)
          }}
          onClick={() => filePicker.current?.click()}
        >
          Drop files here to upload
        </button>
      ) : null}

      {busy ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="card">
          <Empty title="No media yet" hint="Upload images and files to use across your content." />
        </div>
      ) : (
        <>
          <div className="mediagrid">
            {items.map(item => (
              <button
                type="button"
                key={item.id}
                className="mediatile"
                style={{ padding: 0, font: "inherit", textAlign: "left" }}
                onClick={() => setActive(item)}
              >
                <div className="mediathumb">
                  {item.mime.startsWith("image/") ? (
                    <img src={item.url} alt={item.alt ?? item.filename} loading="lazy" />
                  ) : (
                    <FileText size={22} />
                  )}
                </div>
                <div className="medianame">{item.filename}</div>
              </button>
            ))}
          </div>
          {total > 60 ? (
            <div className="pager mediapager">
              <span>
                {(page - 1) * 60 + 1}–{Math.min(page * 60, total)} of {total}
              </span>
              <div className="rowend">
                <button type="button" className="btn sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                  Previous
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={page * 60 >= total}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}

      {active ? (
        <MediaDetail
          item={active}
          canManage={canManage}
          onClose={() => setActive(null)}
          onChange={() => {
            setActive(null)
            load()
          }}
          toast={toast}
        />
      ) : null}
    </>
  )
}

const MediaDetail = ({
  item,
  canManage,
  onClose,
  onChange,
  toast,
}: {
  item: Media
  canManage: boolean
  onClose: () => void
  onChange: () => void
  toast: (message: string, bad?: boolean) => void
}) => {
  const [alt, setAlt] = useState(item.alt ?? "")
  const [caption, setCaption] = useState(item.caption ?? "")
  const [folder, setFolder] = useState(item.folder ?? "")

  return (
    <Modal
      title={item.filename}
      onClose={onClose}
      footer={
        canManage ? (
          <>
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                if (!confirm(`Delete ${item.filename}?`)) return
                await api.deleteMedia(item.id).catch(error => toast(errorOf(error), true))
                onChange()
              }}
            >
              <Trash2 size={14} /> Delete
            </button>
            <button
              type="button"
              className="btn primary rowend"
              onClick={async () => {
                await api.updateMedia(item.id, { alt, caption, folder }).catch(error => toast(errorOf(error), true))
                onChange()
              }}
            >
              Save
            </button>
          </>
        ) : undefined
      }
    >
      {item.mime.startsWith("image/") ? (
        <img
          src={item.url}
          alt={item.alt ?? ""}
          style={{ width: "100%", borderRadius: 8, marginBottom: 16, background: "var(--paper3)" }}
        />
      ) : null}

      <div className="dim2" style={{ marginBottom: 14 }}>
        {item.mime} · {bytes(item.size)}
        {item.width ? ` · ${item.width}×${item.height}` : ""}
      </div>

      <label className="f">
        <span className="fl">Alt text</span>
        <input
          disabled={!canManage}
          value={alt}
          onChange={event => setAlt(event.target.value)}
          placeholder="Describe this image"
        />
        <span className="fh">Read aloud by screen readers and shown if the image fails to load.</span>
      </label>

      <label className="f">
        <span className="fl">Caption</span>
        <input disabled={!canManage} value={caption} onChange={event => setCaption(event.target.value)} />
      </label>

      <label className="f">
        <span className="fl">Folder</span>
        <input disabled={!canManage} value={folder} onChange={event => setFolder(event.target.value)} />
        <span className="fh">An optional label for keeping a large library organized.</span>
      </label>

      <label className="f">
        <span className="fl">URL</span>
        <input className="mono" readOnly value={item.url} onFocus={event => event.target.select()} />
      </label>
    </Modal>
  )
}

const Plugins = ({ go, toast }: { go: (route: Route) => void; toast: (message: string, bad?: boolean) => void }) => {
  const [items, setItems] = useState<Plugin[]>([])
  const [busy, setBusy] = useState(true)

  const load = useCallback(() => {
    setBusy(true)
    api
      .plugins()
      .then(setItems)
      .finally(() => setBusy(false))
  }, [])

  useEffect(load, [load])

  const toggle = async (plugin: Plugin) => {
    try {
      if (plugin.enabled) {
        await api.disablePlugin(plugin.name)
        toast(`${plugin.label} disabled`)
      } else {
        const result = await api.enablePlugin(plugin.name)
        toast(result.enabled.length > 1 ? `Enabled ${result.enabled.join(", ")}` : `${plugin.label} enabled`)
      }
      load()
    } catch (error) {
      toast(errorOf(error), true)
    }
  }

  if (busy) return <Spinner />

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <h1>Plugins</h1>
          <p className="dim2">Extensions loaded from the plugins directory.</p>
        </div>
      </div>

      <div className="grid g2">
        {items.map(plugin => (
          <div className="card" key={plugin.name}>
            <div className="cardbody">
              <div className="row" style={{ marginBottom: 7 }}>
                <h3>{plugin.label}</h3>
                <span className={cx("pill rowend", plugin.enabled ? "on" : "off")}>
                  {plugin.enabled ? "enabled" : "disabled"}
                </span>
              </div>

              <p className="dim2" style={{ minHeight: 34 }}>
                {plugin.error ? <span style={{ color: "var(--bad)" }}>{plugin.error}</span> : plugin.description}
              </p>

              <div className="dim2" style={{ margin: "10px 0" }}>
                v{plugin.version}
                {plugin.author ? ` · ${plugin.author}` : ""}
                {plugin.requires.length > 0 ? ` · needs ${plugin.requires.join(", ")}` : ""}
              </div>

              {plugin.contentTypes.length > 0 ? (
                <div className="wrap" style={{ marginBottom: 12 }}>
                  {plugin.contentTypes.map(name => (
                    <span className="pill" key={name}>
                      {name}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="row">
                <button type="button" className="btn" onClick={() => toggle(plugin)} disabled={!!plugin.error}>
                  {plugin.enabled ? "Disable" : "Enable"}
                </button>
                {plugin.enabled && plugin.panels.length > 0 ? (
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => {
                      const first = plugin.panels[0]
                      if (first) go({ name: "plugin", plugin: plugin.name, panel: first.id })
                    }}
                  >
                    Open
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// One series, so no legend — the heading names it — and no number on every
// column. Exact values are on hover and in the tiles above; the columns are
// here to show shape. A quiet day arrives as a zero-height column rather than
// being dropped, which is what keeps the horizontal axis honest.
const Bars = ({ label, points }: { label: string; points: { label: string; value: number }[] }) => {
  const ceiling = Math.max(...points.map(point => point.value), 1)
  // Thin the axis labels rather than rotating them — 90 columns cannot each
  // carry a date, and a rotated tick is harder to read than a missing one.
  const every = Math.max(1, Math.ceil(points.length / 7))

  return (
    <div className="card">
      <div className="cardhead">
        <h2>{label}</h2>
      </div>
      <div className="cardbody">
        <div className="chart">
          {/* A point's label is its day, which is distinct within any window a
              range switch can ask for, so it keys the column on its own. */}
          {points.map(point => (
            <div className="chartcol" key={point.label} title={`${point.label}: ${point.value}`}>
              <div className="charttip">
                <strong>{point.value}</strong> {point.label}
              </div>
              {/* A bar has a 2px floor so a single view is still visible, which
                  would otherwise make a day with none look like a day with one.
                  Zero gets no bar at all; the column is still hoverable. */}
              {point.value > 0 ? (
                <div className="chartbar" style={{ height: `${(point.value / ceiling) * 100}%` }} />
              ) : null}
            </div>
          ))}
        </div>
        <div className="chartaxis">
          {points.map((point, index) => (
            <span key={point.label}>{index % every === 0 || index === points.length - 1 ? point.label : ""}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

// A "stats" panel is a plugin's dashboard. The plugin does the aggregating and
// the formatting and hands back a PluginStats payload; this only lays it out,
// which is what lets a plugin add a dashboard to a bundle built before it
// existed. See src/plugins/define.ts#PluginStats.
const StatsPanel = ({ panel, toast }: { panel: PluginPanel; toast: (message: string, bad?: boolean) => void }) => {
  const ranges = panel.ranges ?? []
  const [days, setDays] = useState<number | undefined>(ranges[0])
  const [stats, setStats] = useState<PluginStatsPayload | null>(null)
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    if (!panel.endpoint) return
    setBusy(true)
    api
      .pluginStats(panel.endpoint, days)
      .then(setStats)
      .catch(error => toast(errorOf(error), true))
      .finally(() => setBusy(false))
  }, [panel.endpoint, days, toast])

  if (!panel.endpoint) return <Note kind="warn">This panel does not declare an endpoint to read from.</Note>
  if (busy && !stats) return <Spinner />
  if (!stats) return <Empty title="Nothing to show" hint={panel.description ?? "This panel returned no data."} />

  return (
    <>
      {ranges.length > 0 ? (
        <div className="row" style={{ marginBottom: 16 }}>
          {ranges.map(range => (
            <button
              type="button"
              key={range}
              className={cx("btn sm", days === range ? "primary" : "ghost")}
              onClick={() => setDays(range)}
            >
              {range} days
            </button>
          ))}
        </div>
      ) : null}

      <div className="grid g4" style={{ marginBottom: 20 }}>
        {stats.tiles.map(tile => (
          <div className="card stat" key={tile.label}>
            <div className="statnum">{tile.value}</div>
            <div className="statlabel">{tile.label}</div>
            {tile.hint ? <div className="stathint">{tile.hint}</div> : null}
          </div>
        ))}
      </div>

      {stats.series && stats.series.points.length > 0 ? (
        <div style={{ marginBottom: 20 }}>
          <Bars label={stats.series.label} points={stats.series.points} />
        </div>
      ) : null}

      <div className="grid g2">
        {(stats.tables ?? []).map(table => (
          <div className="card" key={table.label}>
            <div className="cardhead">
              <h2>{table.label}</h2>
            </div>
            {table.rows.length === 0 ? (
              <Empty title="Nothing yet" hint="No activity in this window." />
            ) : (
              <table>
                <thead>
                  <tr>
                    {table.columns.map(column => (
                      <th key={column.key}>{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {/* A stats table is a top-N of something grouped — a path, a
                      referrer, an event name — so its first column is the thing
                      being counted and is distinct across rows. */}
                  {table.rows.map(row => (
                    <tr key={String(row[table.columns[0]?.key ?? ""])}>
                      {table.columns.map(column => (
                        <td key={column.key}>{String(row[column.key] ?? "—")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

// Plugins cannot ship React into a bundle that was built before they existed,
// so they describe panels declaratively and this renders them. See
// src/plugins/define.ts#PluginPanel.
const PluginPanelView = ({
  plugin,
  panel,
  types,
  go,
  toast,
}: {
  plugin: Plugin
  panel: PluginPanel
  types: ContentType[]
  go: (route: Route) => void
  toast: (message: string, bad?: boolean) => void
}) => {
  const [values, setValues] = useState<Record<string, unknown>>(plugin.settingsValues ?? {})
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [busy, setBusy] = useState(panel.kind === "table")

  useEffect(() => {
    if (panel.kind !== "table" || !panel.endpoint) return
    setBusy(true)
    api
      .pluginTable(panel.endpoint)
      .then(setRows)
      .catch(error => toast(errorOf(error), true))
      .finally(() => setBusy(false))
  }, [panel.kind, panel.endpoint, toast])

  if (panel.kind === "collection") {
    const type = types.find(t => t.name === panel.contentType)
    if (!type) return <Note kind="warn">This panel points at a content type that is not installed.</Note>
    return <Collection type={type} canWrite go={go} />
  }

  if (panel.kind === "stats") return <StatsPanel panel={panel} toast={toast} />

  if (panel.kind === "table") {
    const columns = panel.columns ?? []
    return (
      <div className="card">
        <div className="cardhead">
          <h2>{panel.label}</h2>
        </div>
        {busy ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <Empty title="Nothing yet" hint={panel.description ?? "This panel has no records."} />
        ) : (
          <table>
            <thead>
              <tr>
                {columns.map(column => (
                  <th key={column.key}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={(row.id as string) ?? `row${index}`}>
                  {columns.map(column => (
                    <td key={column.key}>
                      {column.key.endsWith("At") ? ago(row[column.key] as string) : String(row[column.key] ?? "—")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    )
  }

  return (
    <div className="card">
      <div className="cardhead">
        <h2>{panel.label}</h2>
      </div>
      <div className="cardbody">
        {panel.description ? (
          <p className="dim2" style={{ marginBottom: 16 }}>
            {panel.description}
          </p>
        ) : null}

        {plugin.settings.length === 0 ? (
          <Empty title="No settings" hint="This plugin does not expose any options." />
        ) : (
          <>
            {plugin.settings.map(setting => (
              <FieldInput
                key={setting.key}
                field={{
                  key: setting.key,
                  type: setting.type,
                  label: setting.label,
                  help: setting.help,
                  options: setting.options,
                }}
                value={values[setting.key] ?? setting.default}
                onChange={value => setValues(current => ({ ...current, [setting.key]: value }))}
              />
            ))}
            <button
              type="button"
              className="btn primary"
              onClick={async () => {
                try {
                  await api.savePluginSettings(plugin.name, values)
                  toast("Settings saved")
                } catch (error) {
                  toast(errorOf(error), true)
                }
              }}
            >
              Save settings
            </button>
          </>
        )}
      </div>
    </div>
  )
}

const TaxonomiesScreen = ({ toast }: { toast: (message: string, bad?: boolean) => void }) => {
  const [groups, setGroups] = useState<Taxonomy[]>([])
  const [selectedName, setSelectedName] = useState("")
  const [terms, setTerms] = useState<Term[]>([])
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [groupForm, setGroupForm] = useState({ label: "", hierarchical: false })
  const [termForm, setTermForm] = useState({ id: "", label: "", description: "", parentId: "" })
  const [busy, setBusy] = useState(true)

  const loadGroups = useCallback(async () => {
    const next = await api.taxonomies()
    setGroups(next)
    setSelectedName(current => (next.some(group => group.name === current) ? current : (next[0]?.name ?? "")))
    setBusy(false)
  }, [])

  const loadTerms = useCallback(async () => {
    if (!selectedName) {
      setTerms([])
      return
    }
    setTerms(await api.terms(selectedName))
  }, [selectedName])

  useEffect(() => {
    void loadGroups().catch(error => {
      toast(errorOf(error), true)
      setBusy(false)
    })
  }, [loadGroups, toast])

  useEffect(() => {
    void loadTerms().catch(error => toast(errorOf(error), true))
  }, [loadTerms, toast])

  const selected = groups.find(group => group.name === selectedName)
  const resetTerm = () => setTermForm({ id: "", label: "", description: "", parentId: "" })

  if (busy) return <Spinner />

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <h1>Categories</h1>
          <p className="dim2">Organize content into groups visitors can browse and filter.</p>
        </div>
        <button type="button" className="btn primary rowend" onClick={() => setCreatingGroup(true)}>
          <Plus size={14} /> New group
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="card">
          <Empty
            title="No category groups yet"
            hint="Create something like Product categories, Topics, or Regions, then add choices inside it."
            action={
              <button type="button" className="btn primary" onClick={() => setCreatingGroup(true)}>
                <Plus size={14} /> Create a category group
              </button>
            }
          />
        </div>
      ) : (
        <div className="configsplit">
          <aside className="configlist">
            {groups.map(group => (
              <button
                type="button"
                key={group.id}
                className={cx("configlistitem", selectedName === group.name && "on")}
                onClick={() => {
                  setSelectedName(group.name)
                  resetTerm()
                }}
              >
                <span>{group.label}</span>
                <small>{group.hierarchical ? "Nested" : "Flat"}</small>
              </button>
            ))}
          </aside>

          {selected ? (
            <div className="stack">
              <section className="card">
                <div className="cardhead">
                  <div>
                    <h2>{selected.label}</h2>
                    <p className="dim2">
                      {terms.length} {terms.length === 1 ? "choice" : "choices"}
                    </p>
                  </div>
                  {!selected.ownerPlugin ? (
                    <button
                      type="button"
                      className="btn danger sm rowend"
                      onClick={async () => {
                        if (!confirm(`Delete ${selected.label} and all its choices?`)) return
                        try {
                          await api.deleteTaxonomy(selected.name)
                          await loadGroups()
                          toast(`${selected.label} deleted`)
                        } catch (error) {
                          toast(errorOf(error), true)
                        }
                      }}
                    >
                      Delete group
                    </button>
                  ) : (
                    <span className="pill rowend">{selected.ownerPlugin} plugin</span>
                  )}
                </div>
                {terms.length === 0 ? (
                  <Empty
                    title="No choices yet"
                    hint={`Add the first choice editors can assign under ${selected.label}.`}
                  />
                ) : (
                  <div className="termlist">
                    {terms.map(term => (
                      <div className="termrow" key={term.id}>
                        <div>
                          <strong>{term.label}</strong>
                          <div className="dim2">
                            {term.parentId
                              ? `${terms.find(parent => parent.id === term.parentId)?.label ?? "Nested"} / `
                              : ""}
                            {term.slug}
                          </div>
                        </div>
                        <div className="rowend">
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() =>
                              setTermForm({
                                id: term.id,
                                label: term.label,
                                description: term.description ?? "",
                                parentId: term.parentId ?? "",
                              })
                            }
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn danger sm"
                            onClick={async () => {
                              if (!confirm(`Delete ${term.label}? It will be removed from every entry.`)) return
                              try {
                                await api.deleteTerm(term.id)
                                await loadTerms()
                              } catch (error) {
                                toast(errorOf(error), true)
                              }
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <form
                className="card cardbody"
                onSubmit={async event => {
                  event.preventDefault()
                  try {
                    if (termForm.id) {
                      await api.updateTerm(termForm.id, {
                        label: termForm.label,
                        description: termForm.description || undefined,
                      })
                      toast("Choice updated")
                    } else {
                      await api.createTerm(selected.name, {
                        label: termForm.label,
                        description: termForm.description || undefined,
                        parentId: termForm.parentId || undefined,
                      })
                      toast("Choice added")
                    }
                    resetTerm()
                    await loadTerms()
                  } catch (error) {
                    toast(errorOf(error), true)
                  }
                }}
              >
                <div className="formheading">
                  <h3>{termForm.id ? "Edit choice" : "Add a choice"}</h3>
                  {termForm.id ? (
                    <button type="button" className="btn ghost sm rowend" onClick={resetTerm}>
                      Cancel editing
                    </button>
                  ) : null}
                </div>
                <label className="f">
                  <span className="fl">Label</span>
                  <input
                    type="text"
                    value={termForm.label}
                    placeholder="Coffee"
                    required
                    onChange={event => setTermForm(current => ({ ...current, label: event.target.value }))}
                  />
                </label>
                {selected.hierarchical && !termForm.id ? (
                  <label className="f">
                    <span className="fl">Parent choice</span>
                    <select
                      value={termForm.parentId}
                      onChange={event => setTermForm(current => ({ ...current, parentId: event.target.value }))}
                    >
                      <option value="">None—top level</option>
                      {terms.map(term => (
                        <option key={term.id} value={term.id}>
                          {term.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="f">
                  <span className="fl">Description</span>
                  <textarea
                    rows={2}
                    value={termForm.description}
                    placeholder="Optional note for editors or your website"
                    onChange={event => setTermForm(current => ({ ...current, description: event.target.value }))}
                  />
                </label>
                <button type="submit" className="btn primary">
                  {termForm.id ? "Save choice" : "Add choice"}
                </button>
              </form>
            </div>
          ) : null}
        </div>
      )}

      {creatingGroup ? (
        <Modal
          title="New category group"
          onClose={() => setCreatingGroup(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setCreatingGroup(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={async () => {
                  try {
                    const created = await api.createTaxonomy(groupForm)
                    await loadGroups()
                    setSelectedName(created.name)
                    setCreatingGroup(false)
                    setGroupForm({ label: "", hierarchical: false })
                    toast(`${created.label} created`)
                  } catch (error) {
                    toast(errorOf(error), true)
                  }
                }}
              >
                Create group
              </button>
            </>
          }
        >
          <label className="f">
            <span className="fl">Name</span>
            <input
              type="text"
              value={groupForm.label}
              placeholder="Product categories"
              onChange={event => setGroupForm(current => ({ ...current, label: event.target.value }))}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={groupForm.hierarchical}
              onChange={event => setGroupForm(current => ({ ...current, hierarchical: event.target.checked }))}
            />
            <span>Allow choices inside other choices</span>
          </label>
        </Modal>
      ) : null}
    </>
  )
}

type EditableMenuItem = Omit<MenuItem, "children"> & { key: string; children?: EditableMenuItem[] }

const editableMenuItems = (items: MenuItem[]): EditableMenuItem[] =>
  items.map(item => ({
    ...item,
    key: crypto.randomUUID(),
    children: item.children ? editableMenuItems(item.children) : undefined,
  }))

const storedMenuItems = (items: EditableMenuItem[]): MenuItem[] =>
  items.map(({ key: _, children, ...item }) => ({
    ...item,
    ...(children && children.length > 0 ? { children: storedMenuItems(children) } : {}),
  }))

const newMenuItem = (): EditableMenuItem => ({ key: crypto.randomUUID(), label: "New link", url: "/" })

const MenuItemEditor = ({
  item,
  index,
  count,
  depth,
  onChange,
  onRemove,
  onMove,
}: {
  item: EditableMenuItem
  index: number
  count: number
  depth: number
  onChange: (item: EditableMenuItem) => void
  onRemove: () => void
  onMove: (direction: -1 | 1) => void
}) => {
  const children = item.children ?? []
  return (
    <div className={cx("menuitemeditor", depth > 0 && "nested")}>
      <div className="menuitemfields">
        <label className="f">
          <span className="fl">Label</span>
          <input value={item.label} onChange={event => onChange({ ...item, label: event.target.value })} />
        </label>
        <label className="f">
          <span className="fl">Link</span>
          <input
            type="text"
            value={item.url ?? ""}
            placeholder="/shop or https://…"
            onChange={event => onChange({ ...item, url: event.target.value })}
          />
        </label>
        <label className="check menuitemtarget">
          <input
            type="checkbox"
            checked={item.target === "_blank"}
            onChange={event => onChange({ ...item, target: event.target.checked ? "_blank" : "_self" })}
          />
          <span>Open in a new tab</span>
        </label>
      </div>
      <div className="menuitemactions">
        <button
          type="button"
          className="btn ghost sm"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          aria-label="Move up"
        >
          <ArrowUp size={14} />
        </button>
        <button
          type="button"
          className="btn ghost sm"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
          aria-label="Move down"
        >
          <ArrowDown size={14} />
        </button>
        {depth < 3 ? (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => onChange({ ...item, children: [...children, newMenuItem()] })}
          >
            <Plus size={13} /> Sub-link
          </button>
        ) : null}
        <button type="button" className="btn ghost sm" onClick={onRemove} aria-label="Remove link">
          <Trash2 size={14} />
        </button>
      </div>
      {children.length > 0 ? (
        <div className="menuchildren">
          {children.map((child, childIndex) => (
            <MenuItemEditor
              key={child.key}
              item={child}
              index={childIndex}
              count={children.length}
              depth={depth + 1}
              onChange={next =>
                onChange({
                  ...item,
                  children: children.map((value, position) => (position === childIndex ? next : value)),
                })
              }
              onRemove={() =>
                onChange({ ...item, children: children.filter((_, position) => position !== childIndex) })
              }
              onMove={direction => {
                const target = childIndex + direction
                if (target < 0 || target >= children.length) return
                const next = [...children]
                ;[next[childIndex], next[target]] = [
                  next[target] as EditableMenuItem,
                  next[childIndex] as EditableMenuItem,
                ]
                onChange({ ...item, children: next })
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

const MenusScreen = ({ toast }: { toast: (message: string, bad?: boolean) => void }) => {
  const [menus, setMenus] = useState<Awaited<ReturnType<typeof api.menus>>>([])
  const [selectedName, setSelectedName] = useState("")
  const [label, setLabel] = useState("")
  const [items, setItems] = useState<EditableMenuItem[]>([])
  const [creating, setCreating] = useState(false)
  const [newLabel, setNewLabel] = useState("")
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(true)
  useUnsavedWarning(dirty)

  const load = useCallback(async () => {
    const next = await api.menus()
    setMenus(next)
    setSelectedName(current => (next.some(menu => menu.name === current) ? current : (next[0]?.name ?? "")))
    setBusy(false)
  }, [])

  useEffect(() => {
    void load().catch(error => {
      toast(errorOf(error), true)
      setBusy(false)
    })
  }, [load, toast])

  const selected = menus.find(menu => menu.name === selectedName)
  useEffect(() => {
    if (!selected) return
    setLabel(selected.label)
    setItems(editableMenuItems(selected.items))
    setDirty(false)
  }, [selected])

  if (busy) return <Spinner />

  const setLinks = (next: EditableMenuItem[]) => {
    setItems(next)
    setDirty(true)
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <h1>Menus</h1>
          <p className="dim2">Build navigation your website can place in its header, footer, or anywhere else.</p>
        </div>
        <button type="button" className="btn primary rowend" onClick={() => setCreating(true)}>
          <Plus size={14} /> New menu
        </button>
      </div>

      {menus.length === 0 ? (
        <div className="card">
          <Empty
            title="No menus yet"
            hint="Create a menu, add links in the order visitors should see them, and your site can render it."
            action={
              <button type="button" className="btn primary" onClick={() => setCreating(true)}>
                <Plus size={14} /> Create a menu
              </button>
            }
          />
        </div>
      ) : (
        <div className="configsplit">
          <aside className="configlist">
            {menus.map(menu => (
              <button
                type="button"
                key={menu.id}
                className={cx("configlistitem", selectedName === menu.name && "on")}
                onClick={() => {
                  if (dirty && !confirm("Switch menus without saving your changes?")) return
                  setSelectedName(menu.name)
                }}
              >
                <span>{menu.label}</span>
                <small>
                  {menu.items.length} {menu.items.length === 1 ? "link" : "links"}
                </small>
              </button>
            ))}
          </aside>

          {selected ? (
            <div>
              <div className="buildertop" style={{ marginBottom: 14 }}>
                <label className="menutitle">
                  <span className="definitionlabel">Menu name</span>
                  <input
                    value={label}
                    onChange={event => {
                      setLabel(event.target.value)
                      setDirty(true)
                    }}
                  />
                </label>
                <div className="builderactions">
                  <button
                    type="button"
                    className="btn danger"
                    onClick={async () => {
                      if (!confirm(`Delete ${selected.label}?`)) return
                      try {
                        await api.deleteMenu(selected.name)
                        await load()
                        toast(`${selected.label} deleted`)
                      } catch (error) {
                        toast(errorOf(error), true)
                      }
                    }}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!dirty}
                    onClick={async () => {
                      try {
                        await api.saveMenu(selected.name, label, storedMenuItems(items))
                        await load()
                        toast("Menu saved")
                      } catch (error) {
                        toast(errorOf(error), true)
                      }
                    }}
                  >
                    {dirty ? "Save menu" : "Saved"}
                  </button>
                </div>
              </div>

              {items.length === 0 ? (
                <div className="card">
                  <Empty
                    title="This menu is empty"
                    hint="Add the first link. You can nest sub-links under it later."
                    action={
                      <button type="button" className="btn primary" onClick={() => setLinks([newMenuItem()])}>
                        <Plus size={14} /> Add the first link
                      </button>
                    }
                  />
                </div>
              ) : (
                <div className="menuitems">
                  {items.map((item, index) => (
                    <MenuItemEditor
                      key={item.key}
                      item={item}
                      index={index}
                      count={items.length}
                      depth={0}
                      onChange={next => setLinks(items.map((value, position) => (position === index ? next : value)))}
                      onRemove={() => setLinks(items.filter((_, position) => position !== index))}
                      onMove={direction => {
                        const target = index + direction
                        if (target < 0 || target >= items.length) return
                        const next = [...items]
                        ;[next[index], next[target]] = [
                          next[target] as EditableMenuItem,
                          next[index] as EditableMenuItem,
                        ]
                        setLinks(next)
                      }}
                    />
                  ))}
                  <button type="button" className="btn" onClick={() => setLinks([...items, newMenuItem()])}>
                    <Plus size={14} /> Add link
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      {creating ? (
        <Modal
          title="New menu"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={async () => {
                  try {
                    const created = await api.createMenu(newLabel)
                    await load()
                    setSelectedName(created.name)
                    setCreating(false)
                    setNewLabel("")
                  } catch (error) {
                    toast(errorOf(error), true)
                  }
                }}
              >
                Create menu
              </button>
            </>
          }
        >
          <label className="f">
            <span className="fl">Name</span>
            <input value={newLabel} placeholder="Main navigation" onChange={event => setNewLabel(event.target.value)} />
          </label>
        </Modal>
      ) : null}
    </>
  )
}

const TrashScreen = ({
  types,
  canPurgeEntries,
  canPurgeMedia,
  toast,
}: {
  types: ContentType[]
  canPurgeEntries: boolean
  canPurgeMedia: boolean
  toast: (message: string, bad?: boolean) => void
}) => {
  const [tab, setTab] = useState<"entries" | "media">("entries")
  const [entryItems, setEntryItems] = useState<Entry[]>([])
  const [mediaItems, setMediaItems] = useState<Media[]>([])
  const [busy, setBusy] = useState(true)

  const load = useCallback(async () => {
    setBusy(true)
    const [nextEntries, nextMedia] = await Promise.all([api.trashEntries(), api.trashMedia()])
    setEntryItems(nextEntries)
    setMediaItems(nextMedia)
    setBusy(false)
  }, [])

  useEffect(() => {
    void load().catch(error => {
      toast(errorOf(error), true)
      setBusy(false)
    })
  }, [load, toast])

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <h1>Trash</h1>
        <p className="dim2">Restore something deleted by mistake, or remove it permanently.</p>
      </div>
      <div className="tabs">
        <button type="button" className={cx("tab", tab === "entries" && "on")} onClick={() => setTab("entries")}>
          Content ({entryItems.length})
        </button>
        <button type="button" className={cx("tab", tab === "media" && "on")} onClick={() => setTab("media")}>
          Media ({mediaItems.length})
        </button>
      </div>

      <div className="card tablewrap">
        {busy ? (
          <Spinner />
        ) : tab === "entries" ? (
          entryItems.length === 0 ? (
            <Empty
              title="No deleted content"
              hint="Entries moved to trash will wait here until you restore or permanently delete them."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Content type</th>
                  <th>Deleted</th>
                  <th aria-label="Actions" style={{ width: 210 }} />
                </tr>
              </thead>
              <tbody>
                {entryItems.map(entry => (
                  <tr key={entry.id}>
                    <td style={{ fontWeight: 550 }}>{entry.title || "Untitled"}</td>
                    <td className="dim">
                      {types.find(type => type.id === entry.contentTypeId)?.label ?? "Unknown content"}
                    </td>
                    <td className="dim2">{ago(entry.deletedAt)}</td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          className="btn sm"
                          onClick={async () => {
                            try {
                              await api.restoreEntry(entry.id)
                              await load()
                              toast(`${entry.title} restored as a draft`)
                            } catch (error) {
                              toast(errorOf(error), true)
                            }
                          }}
                        >
                          <RotateCcw size={13} /> Restore
                        </button>
                        {canPurgeEntries ? (
                          <button
                            type="button"
                            className="btn danger sm"
                            onClick={async () => {
                              if (
                                !confirm(`Permanently delete "${entry.title}" and its history? This cannot be undone.`)
                              )
                                return
                              try {
                                await api.purgeEntry(entry.id)
                                await load()
                              } catch (error) {
                                toast(errorOf(error), true)
                              }
                            }}
                          >
                            Delete forever
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : mediaItems.length === 0 ? (
          <Empty
            title="No deleted media"
            hint="Deleted files stay recoverable here until you permanently remove them."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Type</th>
                <th>Deleted</th>
                <th aria-label="Actions" style={{ width: 210 }} />
              </tr>
            </thead>
            <tbody>
              {mediaItems.map(item => (
                <tr key={item.id}>
                  <td style={{ fontWeight: 550 }}>{item.filename}</td>
                  <td className="dim">{item.mime}</td>
                  <td className="dim2">{ago(item.deletedAt)}</td>
                  <td>
                    <div className="row">
                      <button
                        type="button"
                        className="btn sm"
                        onClick={async () => {
                          try {
                            await api.restoreMedia(item.id)
                            await load()
                            toast(`${item.filename} restored`)
                          } catch (error) {
                            toast(errorOf(error), true)
                          }
                        }}
                      >
                        <RotateCcw size={13} /> Restore
                      </button>
                      {canPurgeMedia ? (
                        <button
                          type="button"
                          className="btn danger sm"
                          onClick={async () => {
                            if (!confirm(`Permanently delete ${item.filename}? This cannot be undone.`)) return
                            try {
                              await api.purgeMedia(item.id)
                              await load()
                            } catch (error) {
                              toast(errorOf(error), true)
                            }
                          }}
                        >
                          Delete forever
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

const WebhooksScreen = ({ toast }: { toast: (message: string, bad?: boolean) => void }) => {
  const emptyForm = { id: "", name: "", url: "", events: [] as string[], active: true }
  const [items, setItems] = useState<Webhook[]>([])
  const [events, setEvents] = useState<string[]>([])
  const [form, setForm] = useState(emptyForm)
  const [editing, setEditing] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)

  const load = useCallback(async () => {
    const result = await api.webhooks()
    setItems(result.data)
    setEvents(result.events)
    setBusy(false)
  }, [])

  useEffect(() => {
    void load().catch(error => {
      toast(errorOf(error), true)
      setBusy(false)
    })
  }, [load, toast])

  const open = (item?: Webhook) => {
    setForm(
      item
        ? { id: item.id, name: item.name, url: item.url, events: item.events, active: item.active }
        : { ...emptyForm },
    )
    setEditing(true)
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <h1>Webhooks</h1>
          <p className="dim2">Notify another service when content or media changes.</p>
        </div>
        <button type="button" className="btn primary rowend" onClick={() => open()}>
          <Plus size={14} /> New webhook
        </button>
      </div>

      <div className="card tablewrap">
        {busy ? (
          <Spinner />
        ) : items.length === 0 ? (
          <Empty
            title="No webhooks yet"
            hint="Add an endpoint when another service needs to rebuild, clear a cache, or react to publishing."
            action={
              <button type="button" className="btn primary" onClick={() => open()}>
                <Plus size={14} /> Add a webhook
              </button>
            }
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Endpoint</th>
                <th>Status</th>
                <th>Last delivery</th>
                <th aria-label="Actions" style={{ width: 210 }} />
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id}>
                  <td style={{ fontWeight: 550 }}>
                    {item.name}{" "}
                    <span className={cx("pill", item.active ? "on" : "off")}>{item.active ? "active" : "paused"}</span>
                  </td>
                  <td className="mono dim webhookurl">{item.url}</td>
                  <td>
                    {item.lastStatus === null ? (
                      <span className="dim2">Not sent</span>
                    ) : (
                      <span className={cx("pill", item.lastStatus >= 200 && item.lastStatus < 300 ? "on" : "archived")}>
                        {item.lastStatus || "Failed"}
                      </span>
                    )}
                  </td>
                  <td className="dim2">{ago(item.lastFiredAt)}</td>
                  <td>
                    <div className="row">
                      <button
                        type="button"
                        className="btn sm"
                        onClick={async () => {
                          try {
                            const result = await api.testWebhook(item.id)
                            toast(
                              result.delivered ? `Test returned ${result.status}` : "The endpoint could not be reached",
                              !result.delivered,
                            )
                            await load()
                          } catch (error) {
                            toast(errorOf(error), true)
                          }
                        }}
                      >
                        Test
                      </button>
                      <button type="button" className="btn sm" onClick={() => open(item)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn danger sm"
                        aria-label={`Delete ${item.name}`}
                        onClick={async () => {
                          if (!confirm(`Delete ${item.name}?`)) return
                          try {
                            await api.deleteWebhook(item.id)
                            await load()
                          } catch (error) {
                            toast(errorOf(error), true)
                          }
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing ? (
        <Modal
          title={form.id ? "Edit webhook" : "New webhook"}
          onClose={() => setEditing(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!form.name || !form.url || form.events.length === 0}
                onClick={async () => {
                  try {
                    if (form.id) {
                      await api.updateWebhook(form.id, form)
                      toast("Webhook updated")
                    } else {
                      const created = await api.createWebhook(form)
                      setSecret(created.secret)
                      toast("Webhook created")
                    }
                    setEditing(false)
                    await load()
                  } catch (error) {
                    toast(errorOf(error), true)
                  }
                }}
              >
                {form.id ? "Save changes" : "Create webhook"}
              </button>
            </>
          }
        >
          <label className="f">
            <span className="fl">Name</span>
            <input
              value={form.name}
              placeholder="Website rebuild"
              onChange={event => setForm({ ...form, name: event.target.value })}
            />
          </label>
          <label className="f">
            <span className="fl">Endpoint URL</span>
            <input
              type="url"
              value={form.url}
              placeholder="https://…"
              onChange={event => setForm({ ...form, url: event.target.value })}
            />
          </label>
          <fieldset className="webhookevents">
            <legend>Send when</legend>
            {events.map(event => (
              <label className="check" key={event}>
                <input
                  type="checkbox"
                  checked={form.events.includes(event)}
                  onChange={() =>
                    setForm({
                      ...form,
                      events: form.events.includes(event)
                        ? form.events.filter(value => value !== event)
                        : [...form.events, event],
                    })
                  }
                />
                <span>{event.replace(".", " ")}</span>
              </label>
            ))}
          </fieldset>
          <label className="check" style={{ marginTop: 16 }}>
            <input
              type="checkbox"
              checked={form.active}
              onChange={event => setForm({ ...form, active: event.target.checked })}
            />
            <span>Active</span>
          </label>
        </Modal>
      ) : null}

      {secret ? (
        <Modal
          title="Copy the signing secret"
          onClose={() => setSecret(null)}
          footer={
            <button type="button" className="btn primary" onClick={() => setSecret(null)}>
              Done
            </button>
          }
        >
          <Note kind="warn">
            This secret is shown once. Your endpoint uses it to verify that deliveries came from Inkling.
          </Note>
          <input
            className="mono"
            readOnly
            value={secret}
            style={{ marginTop: 14 }}
            onFocus={event => event.target.select()}
          />
        </Modal>
      ) : null}
    </>
  )
}

const ACTIVITY_LABELS: Record<string, string> = {
  "auth.setup": "Created the site",
  "auth.login": "Signed in",
  "auth.login.failed": "Sign-in failed",
  "auth.login.throttled": "Sign-in was rate-limited",
  "auth.logout": "Signed out",
  "auth.password.changed": "Changed a password",
  "auth.sessions.revokedall": "Signed out all sessions",
  "content.created": "Created content",
  "content.updated": "Updated content",
  "content.published": "Published content",
  "content.unpublished": "Moved content to draft",
  "content.deleted": "Moved content to trash",
  "media.uploaded": "Uploaded media",
  "media.deleted": "Moved media to trash",
}

const activityDetail = (event: AuditEvent): string => {
  const metadata = event.metadata ?? {}
  for (const key of ["title", "filename", "email", "slug"]) {
    if (typeof metadata[key] === "string") return metadata[key]
  }
  return event.ip ?? "—"
}

const ActivityScreen = () => {
  const [items, setItems] = useState<AuditEvent[]>([])
  const [busy, setBusy] = useState(true)
  const [q, setQ] = useState("")
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    setBusy(true)
    const timer = setTimeout(() => {
      void api
        .audit({ q, page, limit: 50 })
        .then(result => {
          setItems(result.data)
          setTotal(result.meta.total)
        })
        .finally(() => setBusy(false))
    }, 180)
    return () => clearTimeout(timer)
  }, [page, q])

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <h1>Activity</h1>
          <p className="dim2">A record of sign-ins, publishing, edits, and media changes.</p>
        </div>
        <div className="search rowend">
          <Search size={14} />
          <input
            type="search"
            value={q}
            placeholder="Filter activity…"
            onChange={event => {
              setQ(event.target.value)
              setPage(1)
            }}
          />
        </div>
      </div>
      <div className="card">
        {busy ? (
          <Spinner />
        ) : items.length === 0 ? (
          <Empty title="No activity yet" hint="Publishing and account activity will appear here." />
        ) : (
          <>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Activity</th>
                    <th>Item</th>
                    <th>User</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => (
                    <tr key={item.id}>
                      <td>{ACTIVITY_LABELS[item.event] ?? item.event}</td>
                      <td className="dim">{activityDetail(item)}</td>
                      <td className="dim">{item.userName ?? "System"}</td>
                      <td className="dim2" title={new Date(item.createdAt).toLocaleString()}>
                        {ago(item.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {total > 50 ? (
              <div className="pager">
                <span>
                  {(page - 1) * 50 + 1}–{Math.min(page * 50, total)} of {total}
                </span>
                <div className="rowend">
                  <button type="button" className="btn sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                    Previous
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={page * 50 >= total}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  )
}

const SettingsScreen = ({ toast }: { toast: (message: string, bad?: boolean) => void }) => {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [schema, setSchema] = useState<{ key: string; label: string; type: string }[]>([])
  const [busy, setBusy] = useState(true)
  const [dirty, setDirty] = useState(false)
  useUnsavedWarning(dirty)

  useEffect(() => {
    api
      .settings()
      .then(result => {
        setValues(result.data)
        setSchema(result.schema)
      })
      .finally(() => setBusy(false))
  }, [])

  if (busy) return <Spinner />

  return (
    <>
      <h1 style={{ marginBottom: 18 }}>Settings</h1>
      <div className="card">
        <div className="cardbody">
          {schema.map(item => (
            <FieldInput
              key={item.key}
              field={{ key: item.key, type: item.type, label: item.label }}
              value={values[item.key]}
              onChange={value => {
                setValues(current => ({ ...current, [item.key]: value }))
                setDirty(true)
              }}
            />
          ))}
          <button
            type="button"
            className="btn primary"
            onClick={async () => {
              try {
                await api.saveSettings(values)
                setDirty(false)
                toast("Settings saved")
              } catch (error) {
                toast(errorOf(error), true)
              }
            }}
          >
            Save
          </button>
        </div>
      </div>
    </>
  )
}

const Keys = ({ types, toast }: { types: ContentType[]; toast: (message: string, bad?: boolean) => void }) => {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.keys>>>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState<string[]>([])
  const [expiresAt, setExpiresAt] = useState("")
  const [fresh, setFresh] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .keys()
      .then(setItems)
      .catch(() => {})
  }, [])

  useEffect(load, [load])

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <h1>API keys</h1>
          <p className="dim2">Keys authenticate the delivery API that your website reads from.</p>
        </div>
        <button type="button" className="btn primary rowend" onClick={() => setCreating(true)}>
          <Plus size={14} /> New key
        </button>
      </div>

      <div className="card">
        {items.length === 0 ? (
          <Empty title="No keys yet" hint="Create a key so a site can read your published content." />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Can read</th>
                <th>Last used</th>
                <th>Expires</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id}>
                  <td style={{ fontWeight: 550 }}>
                    {item.name}
                    {item.revokedAt ? (
                      <span className="pill archived" style={{ marginLeft: 8 }}>
                        revoked
                      </span>
                    ) : null}
                  </td>
                  <td className="mono dim">{item.prefix}…</td>
                  <td className="dim2">
                    {item.scopes.length === 0
                      ? "All content"
                      : item.scopes.map(scope => types.find(type => type.name === scope)?.label ?? scope).join(", ")}
                  </td>
                  <td className="dim2">{ago(item.lastUsedAt)}</td>
                  <td className="dim2">{item.expiresAt ? new Date(item.expiresAt).toLocaleDateString() : "Never"}</td>
                  <td>
                    {item.revokedAt ? null : (
                      <button
                        type="button"
                        className="btn danger sm"
                        onClick={async () => {
                          if (!confirm(`Revoke "${item.name}"? Anything using it stops working immediately.`)) return
                          await api.revokeKey(item.id)
                          load()
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating ? (
        <Modal
          title="New API key"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={async () => {
                  try {
                    const created = await api.createKey(
                      name,
                      scopes,
                      expiresAt ? new Date(expiresAt).toISOString() : undefined,
                    )
                    setFresh(created.key)
                    setCreating(false)
                    setName("")
                    setScopes([])
                    setExpiresAt("")
                    load()
                  } catch (error) {
                    toast(errorOf(error), true)
                  }
                }}
              >
                Create
              </button>
            </>
          }
        >
          <label className="f">
            <span className="fl">Name</span>
            <input value={name} onChange={event => setName(event.target.value)} placeholder="Production website" />
            <span className="fh">Something that identifies where the key is used.</span>
          </label>
          <fieldset className="keyscopes">
            <legend>Content access</legend>
            <p className="dim2">
              Leave every box clear to allow all published content, or choose only what this site needs.
            </p>
            {types.map(type => (
              <label className="check" key={type.id}>
                <input
                  type="checkbox"
                  checked={scopes.includes(type.name)}
                  onChange={() =>
                    setScopes(current =>
                      current.includes(type.name)
                        ? current.filter(scope => scope !== type.name)
                        : [...current, type.name],
                    )
                  }
                />
                <span>{type.label}</span>
              </label>
            ))}
          </fieldset>
          <label className="f" style={{ marginTop: 16 }}>
            <span className="fl">Expires</span>
            <input
              type="datetime-local"
              min={localDateTime()}
              value={expiresAt}
              onChange={event => setExpiresAt(event.target.value)}
            />
            <span className="fh">Optional. Leave blank for a key that does not expire.</span>
          </label>
        </Modal>
      ) : null}

      {fresh ? (
        <Modal
          title="Copy your key"
          onClose={() => setFresh(null)}
          footer={
            <button type="button" className="btn primary" onClick={() => setFresh(null)}>
              Done
            </button>
          }
        >
          <Note kind="warn">This is the only time the key is shown. Store it somewhere safe now.</Note>
          <input
            className="mono"
            readOnly
            value={fresh}
            style={{ marginTop: 14 }}
            onFocus={event => event.target.select()}
          />
        </Modal>
      ) : null}
    </>
  )
}

const UsersScreen = ({ me, toast }: { me: Identity; toast: (message: string, bad?: boolean) => void }) => {
  const [items, setItems] = useState<Identity[]>([])
  const [roles, setRoles] = useState<{ value: string; label: string }[]>([])
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "editor" })
  const [fresh, setFresh] = useState<{ email: string; password: string } | null>(null)
  const [resetting, setResetting] = useState<Identity | null>(null)
  const [resetPassword, setResetPassword] = useState("")

  const load = useCallback(() => {
    api
      .users()
      .then(result => {
        setItems(result.data)
        setRoles(result.roles)
      })
      .catch(() => {})
  }, [])

  useEffect(load, [load])

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <h1>Users</h1>
        <button
          type="button"
          className="btn primary rowend"
          onClick={() => {
            setForm({ email: "", name: "", password: temporaryPassword(), role: "editor" })
            setCreating(true)
          }}
        >
          <Plus size={14} /> Add user
        </button>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th style={{ width: 150 }}>Role</th>
              <th style={{ width: 180 }} />
            </tr>
          </thead>
          <tbody>
            {items.map(user => (
              <tr key={user.id}>
                <td style={{ fontWeight: 550 }}>
                  {user.name}
                  {user.id === me.id ? <span className="dim2"> · you</span> : null}
                </td>
                <td className="dim">{user.email}</td>
                <td>
                  <select
                    value={user.role}
                    disabled={user.id === me.id || ROLE_RANK[user.role] > ROLE_RANK[me.role]}
                    onChange={async event => {
                      try {
                        await api.updateUser(user.id, { role: event.target.value })
                        toast("Role updated")
                        load()
                      } catch (error) {
                        toast(errorOf(error), true)
                        load()
                      }
                    }}
                  >
                    {roles.map(role => (
                      <option key={role.value} value={role.value}>
                        {role.label.split(" — ")[0]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {user.id !== me.id && ROLE_RANK[user.role] <= ROLE_RANK[me.role] ? (
                    <div className="row">
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => {
                          setResetPassword(temporaryPassword())
                          setResetting(user)
                        }}
                      >
                        Reset password
                      </button>
                      <button
                        type="button"
                        className="btn danger sm"
                        onClick={async () => {
                          if (!confirm(`Remove ${user.name}?`)) return
                          try {
                            await api.deleteUser(user.id)
                            load()
                          } catch (error) {
                            toast(errorOf(error), true)
                          }
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating ? (
        <Modal
          title="Add a user"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={async () => {
                  try {
                    await api.createUser(form)
                    setFresh({ email: form.email, password: form.password })
                    setCreating(false)
                    setForm({ email: "", name: "", password: "", role: "editor" })
                    load()
                    toast("User created")
                  } catch (error) {
                    toast(errorOf(error), true)
                  }
                }}
              >
                Create
              </button>
            </>
          }
        >
          <label className="f">
            <span className="fl">Name</span>
            <input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} />
          </label>
          <label className="f">
            <span className="fl">Email</span>
            <input
              type="email"
              value={form.email}
              onChange={event => setForm({ ...form, email: event.target.value })}
            />
          </label>
          <label className="f">
            <span className="fl">Temporary password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={event => setForm({ ...form, password: event.target.value })}
            />
            <span className="fh">At least 12 characters. They can change it after signing in.</span>
            <button
              type="button"
              className="btn sm"
              style={{ marginTop: 7 }}
              onClick={() => setForm(current => ({ ...current, password: temporaryPassword() }))}
            >
              Generate another
            </button>
          </label>
          <label className="f">
            <span className="fl">Role</span>
            <select value={form.role} onChange={event => setForm({ ...form, role: event.target.value })}>
              {roles.map(role => (
                <option key={role.value} value={role.value}>
                  {role.label}
                </option>
              ))}
            </select>
          </label>
        </Modal>
      ) : null}

      {resetting ? (
        <Modal
          title={`Reset ${resetting.name}'s password`}
          onClose={() => setResetting(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setResetting(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={resetPassword.length < 12}
                onClick={async () => {
                  try {
                    await api.updateUser(resetting.id, { password: resetPassword })
                    setFresh({ email: resetting.email, password: resetPassword })
                    setResetting(null)
                    toast("Password reset; existing sessions were signed out")
                  } catch (error) {
                    toast(errorOf(error), true)
                  }
                }}
              >
                Reset password
              </button>
            </>
          }
        >
          <Note kind="warn">This signs the user out everywhere. Share the new password with them securely.</Note>
          <label className="f" style={{ marginTop: 14 }}>
            <span className="fl">New temporary password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={resetPassword}
              onChange={event => setResetPassword(event.target.value)}
            />
          </label>
          <button type="button" className="btn sm" onClick={() => setResetPassword(temporaryPassword())}>
            Generate another
          </button>
        </Modal>
      ) : null}

      {fresh ? (
        <Modal
          title="Share these sign-in details"
          onClose={() => setFresh(null)}
          footer={
            <button type="button" className="btn primary" onClick={() => setFresh(null)}>
              Done
            </button>
          }
        >
          <Note kind="warn">The temporary password is shown only here. Copy it before closing this window.</Note>
          <label className="f" style={{ marginTop: 14 }}>
            <span className="fl">Email</span>
            <input readOnly value={fresh.email} onFocus={event => event.target.select()} />
          </label>
          <label className="f">
            <span className="fl">Temporary password</span>
            <input className="mono" readOnly value={fresh.password} onFocus={event => event.target.select()} />
          </label>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              await navigator.clipboard.writeText(`${fresh.email}\n${fresh.password}`)
              toast("Sign-in details copied")
            }}
          >
            Copy both
          </button>
        </Modal>
      ) : null}
    </>
  )
}

const FIELD_TYPES = [
  { value: "text", label: "Short text" },
  { value: "textarea", label: "Long text" },
  { value: "richtext", label: "Rich text" },
  { value: "markdown", label: "Markdown" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "On / off" },
  { value: "date", label: "Date" },
  { value: "datetime", label: "Date and time" },
  { value: "select", label: "One choice" },
  { value: "multiselect", label: "Multiple choices" },
  { value: "media", label: "Image or file" },
  { value: "gallery", label: "Image gallery" },
  { value: "reference", label: "Related content" },
  { value: "list", label: "Repeatable group" },
  { value: "color", label: "Color" },
  { value: "url", label: "Link" },
  { value: "email", label: "Email address" },
  { value: "json", label: "Structured data (JSON)" },
] as const

const keyFromLabel = (value: string): string => {
  const words = value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
  const [first = "field", ...rest] = words
  const key = `${first.toLowerCase()}${rest.map(word => `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`).join("")}`
  return /^[a-z]/.test(key) ? key : `field${key}`
}

const blankField = (): Field => ({
  key: `field${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`,
  label: "New field",
  type: "text",
})

const FieldDefinitionEditor = ({
  field,
  index,
  count,
  types,
  depth = 0,
  onChange,
  onRemove,
  onMove,
}: {
  field: Field
  index: number
  count: number
  types: ContentType[]
  depth?: number
  onChange: (field: Field) => void
  onRemove: () => void
  onMove: (direction: -1 | 1) => void
}) => {
  const changeType = (type: string) => {
    const next: Field = {
      key: field.key,
      label: field.label,
      type,
      ...(field.help ? { help: field.help } : {}),
      ...(field.required ? { required: true } : {}),
    }
    if (type === "select" || type === "multiselect") next.options = [{ value: "option1", label: "Option 1" }]
    if (type === "reference") next.of = types[0]?.name ?? ""
    if (type === "list") next.fields = [blankField()]
    onChange(next)
  }

  const options = field.options ?? []
  const nested = field.fields ?? []

  return (
    <section className={cx("fielddefinition", depth > 0 && "nested")}>
      <div className="fielddefinitionhead">
        <span className="fieldnumber">{index + 1}</span>
        <input
          type="text"
          aria-label="Field label"
          value={field.label}
          onChange={event => {
            const label = event.target.value
            const generatedBefore = keyFromLabel(field.label)
            onChange({
              ...field,
              label,
              key: field.key.startsWith("field") || field.key === generatedBefore ? keyFromLabel(label) : field.key,
            })
          }}
          placeholder="Field label"
        />
        <select aria-label="Field type" value={field.type} onChange={event => changeType(event.target.value)}>
          {FIELD_TYPES.filter(option => depth === 0 || option.value !== "list").map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="fieldactions">
          <button
            type="button"
            className="btn ghost sm"
            aria-label={`Move ${field.label} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="btn ghost sm"
            aria-label={`Move ${field.label} down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown size={14} />
          </button>
          <button type="button" className="btn ghost sm" aria-label={`Remove ${field.label}`} onClick={onRemove}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="fielddefinitionbody">
        <label className="f fieldhelp">
          <span className="fl">Help text</span>
          <input
            type="text"
            value={field.help ?? ""}
            onChange={event => onChange({ ...field, help: event.target.value || undefined })}
            placeholder="Optional guidance shown below the field"
          />
        </label>

        <label className="check fieldrequired">
          <input
            type="checkbox"
            checked={field.required === true}
            onChange={event => onChange({ ...field, required: event.target.checked || undefined })}
          />
          <span>Required</span>
        </label>

        {field.type === "select" || field.type === "multiselect" ? (
          <div className="fieldchoices">
            <div className="definitionlabel">Choices</div>
            {options.map((option, optionIndex) => (
              // Choice rows carry no stored id and can be reordered only by replacing the whole field definition.
              // biome-ignore lint/suspicious/noArrayIndexKey: definition choices have no stable id
              <div className="choiceeditor" key={optionIndex}>
                <input
                  type="text"
                  aria-label={`Choice ${optionIndex + 1} label`}
                  value={option.label}
                  placeholder="Label"
                  onChange={event => {
                    const label = event.target.value
                    const next = [...options]
                    next[optionIndex] = {
                      ...option,
                      label,
                      value: option.value.startsWith("option") ? slugify(label) : option.value,
                    }
                    onChange({ ...field, options: next })
                  }}
                />
                <input
                  type="text"
                  className="mono"
                  aria-label={`Choice ${optionIndex + 1} stored value`}
                  value={option.value}
                  placeholder="value"
                  onChange={event => {
                    const next = [...options]
                    next[optionIndex] = { ...option, value: slugify(event.target.value) }
                    onChange({ ...field, options: next })
                  }}
                />
                <button
                  type="button"
                  className="btn ghost sm"
                  aria-label={`Remove choice ${option.label}`}
                  onClick={() => onChange({ ...field, options: options.filter((_, choice) => choice !== optionIndex) })}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                onChange({
                  ...field,
                  options: [
                    ...options,
                    { value: `option${options.length + 1}`, label: `Option ${options.length + 1}` },
                  ],
                })
              }
            >
              <Plus size={13} /> Add choice
            </button>
          </div>
        ) : null}

        {field.type === "reference" ? (
          <div className="fieldconfig">
            <label className="f">
              <span className="fl">Content to link to</span>
              <select value={field.of ?? ""} onChange={event => onChange({ ...field, of: event.target.value })}>
                <option value="">Choose a content type</option>
                {types.map(type => (
                  <option key={type.id} value={type.name}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={field.multiple === true}
                onChange={event => onChange({ ...field, multiple: event.target.checked || undefined })}
              />
              <span>Allow several related entries</span>
            </label>
          </div>
        ) : null}

        {field.type === "list" ? (
          <div className="nestedfields">
            <div className="nestedfieldshead">
              <div>
                <div className="definitionlabel">Fields in each item</div>
                <div className="dim2">For example, a label and link for each social profile.</div>
              </div>
              <button
                type="button"
                className="btn sm"
                onClick={() => onChange({ ...field, fields: [...nested, blankField()] })}
              >
                <Plus size={13} /> Add nested field
              </button>
            </div>
            {nested.map((child, childIndex) => (
              <FieldDefinitionEditor
                key={child.key}
                field={child}
                index={childIndex}
                count={nested.length}
                types={types}
                depth={depth + 1}
                onChange={next =>
                  onChange({
                    ...field,
                    fields: nested.map((item, position) => (position === childIndex ? next : item)),
                  })
                }
                onRemove={() => onChange({ ...field, fields: nested.filter((_, position) => position !== childIndex) })}
                onMove={direction => {
                  const target = childIndex + direction
                  if (target < 0 || target >= nested.length) return
                  const next = [...nested]
                  ;[next[childIndex], next[target]] = [next[target] as Field, next[childIndex] as Field]
                  onChange({ ...field, fields: next })
                }}
              />
            ))}
          </div>
        ) : null}

        {field.type === "number" || field.type === "text" || field.type === "textarea" || field.type === "list" ? (
          <div className="fieldlimits">
            <label className="f">
              <span className="fl">
                Minimum {field.type === "number" ? "value" : field.type === "list" ? "items" : "length"}
              </span>
              <input
                type="number"
                value={field.min ?? ""}
                min={0}
                onChange={event =>
                  onChange({ ...field, min: event.target.value === "" ? undefined : Number(event.target.value) })
                }
              />
            </label>
            <label className="f">
              <span className="fl">
                Maximum {field.type === "number" ? "value" : field.type === "list" ? "items" : "length"}
              </span>
              <input
                type="number"
                value={field.max ?? ""}
                min={0}
                onChange={event =>
                  onChange({ ...field, max: event.target.value === "" ? undefined : Number(event.target.value) })
                }
              />
            </label>
          </div>
        ) : null}

        <details className="fieldadvanced">
          <summary>Advanced</summary>
          <label className="f">
            <span className="fl">API field name</span>
            <input
              type="text"
              className="mono"
              value={field.key}
              onChange={event => onChange({ ...field, key: event.target.value })}
            />
            <span className="fh">Used by site code. Lower camelCase, with no spaces.</span>
          </label>
          {field.type === "text" || field.type === "textarea" ? (
            <label className="f">
              <span className="fl">Validation pattern</span>
              <input
                type="text"
                className="mono"
                value={field.pattern ?? ""}
                onChange={event => onChange({ ...field, pattern: event.target.value || undefined })}
                placeholder="Optional regular expression"
              />
            </label>
          ) : null}
        </details>
      </div>
    </section>
  )
}

const TypeBuilder = ({
  existing,
  types,
  go,
  onChanged,
  toast,
}: {
  existing: ContentType | null
  types: ContentType[]
  go: (route: Route) => void
  onChanged: () => Promise<void>
  toast: (message: string, bad?: boolean) => void
}) => {
  const [form, setForm] = useState(() => ({
    label: existing?.label ?? "",
    pluralLabel: existing?.pluralLabel ?? "",
    name: existing?.name ?? "",
    description: existing?.description ?? "",
    kind: existing?.kind ?? ("collection" as const),
    previewUrl: existing?.previewUrl ?? "",
    fields: existing?.fields ?? ([] as Field[]),
  }))
  const [nameTouched, setNameTouched] = useState(existing !== null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const initialForm = useRef("")
  if (!initialForm.current) initialForm.current = JSON.stringify(form)
  const dirty = JSON.stringify(form) !== initialForm.current
  useUnsavedWarning(!existing?.ownerPlugin && dirty)

  if (existing?.ownerPlugin) {
    return (
      <>
        <button type="button" className="btn ghost" onClick={() => go({ name: "types" })}>
          <ChevronLeft size={15} /> Content types
        </button>
        <div style={{ marginTop: 18 }}>
          <Note kind="info">This content type is managed by the {existing.ownerPlugin} plugin.</Note>
        </div>
      </>
    )
  }

  const setFields = (fields: Field[]) => setForm(current => ({ ...current, fields }))

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!form.label.trim()) {
      setError("Give this content type a name people will recognize.")
      return
    }
    if (existing) {
      const removed = existing.fields.filter(field => !form.fields.some(next => next.key === field.key))
      const newlyRequired = form.fields.filter(field => {
        const before = existing.fields.find(previous => previous.key === field.key)
        return field.required && !before?.required
      })
      if (
        (removed.length > 0 || newlyRequired.length > 0) &&
        !confirm(
          [
            removed.length > 0 ? `Removed fields: ${removed.map(field => field.label).join(", ")}.` : "",
            newlyRequired.length > 0
              ? `New required fields: ${newlyRequired.map(field => field.label).join(", ")}.`
              : "",
            "Existing entries may need attention before they can be published again. Save these changes?",
          ]
            .filter(Boolean)
            .join("\n\n"),
        )
      ) {
        return
      }
    }
    setBusy(true)
    setError("")
    try {
      const input = {
        label: form.label.trim(),
        pluralLabel: form.pluralLabel.trim() || form.label.trim(),
        name: form.name,
        description: form.description.trim() || null,
        kind: form.kind,
        previewUrl: form.previewUrl.trim() || null,
        fields: form.fields,
      }
      if (existing) await api.updateType(existing.name, input)
      else await api.createType(input)
      await onChanged()
      toast(existing ? `${form.label} updated` : `${form.label} is ready for content`)
      delete document.body.dataset.unsaved
      go({ name: "types" })
    } catch (caught) {
      setError(errorOf(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save}>
      <div className="buildertop">
        <button type="button" className="btn ghost" onClick={() => go({ name: "types" })}>
          <ChevronLeft size={15} /> Content types
        </button>
        <div className="builderactions">
          {existing ? (
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={async () => {
                if (!confirm(`Delete ${existing.label}? This only works when it has no entries.`)) return
                setBusy(true)
                try {
                  await api.deleteType(existing.name)
                  await onChanged()
                  toast(`${existing.label} deleted`)
                  delete document.body.dataset.unsaved
                  go({ name: "types" })
                } catch (caught) {
                  setError(errorOf(caught))
                  setBusy(false)
                }
              }}
            >
              Delete
            </button>
          ) : null}
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "Saving…" : existing ? "Save changes" : "Create content type"}
          </button>
        </div>
      </div>

      <div className="builderheading">
        <h1>{existing ? `Edit ${existing.label}` : "Create a content type"}</h1>
        <p>
          {existing
            ? "Change the fields editors see when working with this content."
            : "Start with what editors call it, then add only the fields they need."}
        </p>
      </div>

      {error ? <Note kind="err">{error}</Note> : null}

      <div className="typebuilder">
        <div className="stack">
          <section className="card cardbody typesetup">
            <div className="typeformgrid">
              <label className="f">
                <span className="fl">Name</span>
                <input
                  type="text"
                  value={form.label}
                  placeholder="Product"
                  onChange={event => {
                    const label = event.target.value
                    setForm(current => ({
                      ...current,
                      label,
                      pluralLabel:
                        !current.pluralLabel || current.pluralLabel === `${current.label}s`
                          ? `${label}${label.endsWith("s") ? "" : "s"}`
                          : current.pluralLabel,
                      name: nameTouched ? current.name : slugify(label).replace(/-/g, ""),
                    }))
                  }}
                />
                <span className="fh">Singular, as editors will see it.</span>
              </label>
              <label className="f">
                <span className="fl">Plural name</span>
                <input
                  type="text"
                  value={form.pluralLabel}
                  placeholder="Products"
                  onChange={event => setForm(current => ({ ...current, pluralLabel: event.target.value }))}
                />
              </label>
            </div>
            <label className="f">
              <span className="fl">Description</span>
              <textarea
                rows={2}
                value={form.description}
                placeholder="What belongs here? A short note helps other editors choose the right place."
                onChange={event => setForm(current => ({ ...current, description: event.target.value }))}
              />
            </label>
            <fieldset className="kindchoice" disabled={existing !== null}>
              <legend>How many can there be?</legend>
              <label className={cx("kindoption", form.kind === "collection" && "selected")}>
                <input
                  type="radio"
                  name="kind"
                  checked={form.kind === "collection"}
                  onChange={() => setForm(current => ({ ...current, kind: "collection" }))}
                />
                <span>
                  <strong>A collection</strong>
                  <small>Many items, such as products, articles, or team members.</small>
                </span>
              </label>
              <label className={cx("kindoption", form.kind === "single" && "selected")}>
                <input
                  type="radio"
                  name="kind"
                  checked={form.kind === "single"}
                  onChange={() => setForm(current => ({ ...current, kind: "single" }))}
                />
                <span>
                  <strong>One page</strong>
                  <small>A single set of content, such as the homepage or contact page.</small>
                </span>
              </label>
            </fieldset>
            <details className="fieldadvanced">
              <summary>Advanced</summary>
              <label className="f">
                <span className="fl">API name</span>
                <input
                  type="text"
                  className="mono"
                  value={form.name}
                  disabled={existing !== null}
                  onChange={event => {
                    setNameTouched(true)
                    setForm(current => ({ ...current, name: event.target.value }))
                  }}
                />
                <span className="fh">Site code uses this name. It cannot change after creation.</span>
              </label>
              <label className="f">
                <span className="fl">Live page URL</span>
                <input
                  type="text"
                  value={form.previewUrl}
                  placeholder={form.kind === "single" ? "/about" : "/articles/{slug}"}
                  onChange={event => setForm(current => ({ ...current, previewUrl: event.target.value }))}
                />
                <span className="fh">
                  Opens from published entries. Use {"{slug}"}, {"{id}"}, {"{locale}"}, or {"{type}"} where needed.
                </span>
              </label>
            </details>
          </section>

          <section className="fieldssection">
            <div className="fieldssectionhead">
              <div>
                <h2>Fields</h2>
                <p className="dim2">These become the form editors fill in.</p>
              </div>
              <button type="button" className="btn" onClick={() => setFields([...form.fields, blankField()])}>
                <Plus size={14} /> Add field
              </button>
            </div>
            {form.fields.length === 0 ? (
              <div className="card">
                <Empty
                  title="What should editors fill in?"
                  hint="Add the first field—perhaps a summary, image, price, or call-to-action link."
                  action={
                    <button type="button" className="btn primary" onClick={() => setFields([blankField()])}>
                      <Plus size={14} /> Add the first field
                    </button>
                  }
                />
              </div>
            ) : (
              <div className="fielddefinitions">
                {form.fields.map((field, index) => (
                  <FieldDefinitionEditor
                    key={field.key}
                    field={field}
                    index={index}
                    count={form.fields.length}
                    types={types}
                    onChange={next =>
                      setFields(form.fields.map((item, position) => (position === index ? next : item)))
                    }
                    onRemove={() => setFields(form.fields.filter((_, position) => position !== index))}
                    onMove={direction => {
                      const target = index + direction
                      if (target < 0 || target >= form.fields.length) return
                      const next = [...form.fields]
                      ;[next[index], next[target]] = [next[target] as Field, next[index] as Field]
                      setFields(next)
                    }}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="builderpreview">
          <div className="card cardbody">
            <h3>Editor preview</h3>
            <p className="dim2" style={{ margin: "4px 0 16px" }}>
              A quick look at the form your team will use.
            </p>
            <label className="f">
              <span className="fl">Title</span>
              <input type="text" disabled placeholder={`Untitled ${form.label.toLowerCase() || "entry"}`} />
            </label>
            {form.fields.length === 0 ? <div className="previewempty">Your fields will appear here.</div> : null}
            {form.fields.slice(0, 8).map((field, index) => (
              // Preview mirrors schema order and has no persistent row identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: preview-only field
              <div className="previewfield" key={index}>
                <span>{field.label || "Unnamed field"}</span>
                <small>{FIELD_TYPES.find(option => option.value === field.type)?.label ?? field.type}</small>
              </div>
            ))}
            {form.fields.length > 8 ? <div className="dim2">+ {form.fields.length - 8} more fields</div> : null}
          </div>
        </aside>
      </div>
    </form>
  )
}

const TypesScreen = ({
  types,
  editing,
  go,
  onChanged,
  toast,
}: {
  types: ContentType[]
  editing?: string
  go: (route: Route) => void
  onChanged: () => Promise<void>
  toast: (message: string, bad?: boolean) => void
}) => {
  if (editing) {
    const existing = editing === "new" ? null : (types.find(type => type.name === editing) ?? null)
    if (editing !== "new" && !existing) return <Note kind="warn">That content type no longer exists.</Note>
    return <TypeBuilder existing={existing} types={types} go={go} onChanged={onChanged} toast={toast} />
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <h1>Content types</h1>
          <p className="dim2">Decide what your team can create and which fields they fill in.</p>
        </div>
        <button type="button" className="btn primary rowend" onClick={() => go({ name: "types", type: "new" })}>
          <Plus size={14} /> New content type
        </button>
      </div>

      <div className="card tablewrap">
        <table>
          <thead>
            <tr>
              <th>Content</th>
              <th style={{ width: 120 }}>Shape</th>
              <th style={{ width: 90 }}>Fields</th>
              <th style={{ width: 150 }}>Managed by</th>
              <th aria-label="Actions" style={{ width: 130 }} />
            </tr>
          </thead>
          <tbody>
            {types.map(type => (
              <tr key={type.id}>
                <td>
                  <button
                    type="button"
                    className="tablelink"
                    onClick={() => go({ name: "collection", type: type.name })}
                  >
                    {type.label}
                  </button>
                  <div className="dim2">{type.description || type.pluralLabel}</div>
                </td>
                <td>
                  <span className="pill">{type.kind === "single" ? "one page" : "collection"}</span>
                </td>
                <td className="dim">{type.fields.length}</td>
                <td className="dim2">{type.ownerPlugin ? `${type.ownerPlugin} plugin` : "Your team"}</td>
                <td>
                  {type.ownerPlugin ? (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => go({ name: "collection", type: type.name })}
                    >
                      View content
                    </button>
                  ) : (
                    <button type="button" className="btn sm" onClick={() => go({ name: "types", type: type.name })}>
                      <Pencil size={12} /> Edit fields
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {types.length === 0 ? (
          <Empty
            title="Create your first kind of content"
            hint="A content type can be a collection like Products, or one page like your Homepage."
            action={
              <button type="button" className="btn primary" onClick={() => go({ name: "types", type: "new" })}>
                <Plus size={14} /> Create a content type
              </button>
            }
          />
        ) : null}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- login

const Login = ({ onDone }: { onDone: (identity: Identity) => void }) => {
  // Focused on mount rather than with autoFocus: same result on a dedicated
  // sign-in page, without the attribute that hurts on shared pages.
  const emailRef = useRef<HTMLInputElement>(null)
  useEffect(() => emailRef.current?.focus(), [])

  const [setupRequired, setSetupRequired] = useState<boolean | null>(null)
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .setupStatus()
      .then(result => setSetupRequired(result.required))
      .catch(() => setSetupRequired(false))
  }, [])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const result = setupRequired ? await api.setup(name, email, password) : await api.login(email, password)
      setToken(result.token)
      onDone(result.user)
    } catch (caught) {
      setError(errorOf(caught))
    } finally {
      setBusy(false)
    }
  }

  if (setupRequired === null) return <Spinner />

  return (
    <div className="login">
      <div className="loginbox">
        <div className="loginhead">
          <div className="brandmark">I</div>
          <h1>Inkling</h1>
          <p>{setupRequired ? "Create the owner account for this site." : "Sign in to manage your content."}</p>
        </div>

        <form className="card" onSubmit={submit}>
          <div className="cardbody">
            {error ? (
              <div style={{ marginBottom: 14 }}>
                <Note kind="err">{error}</Note>
              </div>
            ) : null}

            {setupRequired ? (
              <label className="f">
                <span className="fl">Your name</span>
                <input
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={event => setName(event.target.value)}
                  required
                />
              </label>
            ) : null}

            <label className="f">
              <span className="fl">Email</span>
              <input
                ref={emailRef}
                type="email"
                autoComplete="username"
                value={email}
                onChange={event => setEmail(event.target.value)}
                required
              />
            </label>

            <label className="f" style={{ marginBottom: 18 }}>
              <span className="fl">Password</span>
              <input
                type="password"
                autoComplete={setupRequired ? "new-password" : "current-password"}
                value={password}
                onChange={event => setPassword(event.target.value)}
                required
              />
              {setupRequired ? <span className="fh">Use at least 12 characters.</span> : null}
            </label>

            <button
              type="submit"
              className="btn primary"
              style={{ width: "100%", justifyContent: "center" }}
              disabled={busy}
            >
              {busy ? <span className="spin" /> : null}
              {busy ? (setupRequired ? "Creating your site" : "Signing in") : setupRequired ? "Create site" : "Sign in"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- shell

const GlobalSearch = ({ go }: { go: (route: Route) => void }) => {
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.search>> | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        input.current?.focus()
        setOpen(true)
      }
    }
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    addEventListener("keydown", shortcut)
    addEventListener("mousedown", outside)
    return () => {
      removeEventListener("keydown", shortcut)
      removeEventListener("mousedown", outside)
    }
  }, [])

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults(null)
      return
    }
    const timer = setTimeout(() => {
      void api
        .search(query.trim())
        .then(setResults)
        .catch(() => setResults({ entries: [], media: [] }))
    }, 220)
    return () => clearTimeout(timer)
  }, [query])

  const count = (results?.entries.length ?? 0) + (results?.media.length ?? 0)
  const choose = (route: Route) => {
    setOpen(false)
    setQuery("")
    go(route)
  }

  return (
    <div className="search" ref={root}>
      <Search size={14} />
      <input
        ref={input}
        type="search"
        role="combobox"
        value={query}
        placeholder="Search content and media…"
        aria-label="Search content and media"
        aria-expanded={open && query.length >= 2}
        aria-controls="global-search-results"
        onFocus={() => setOpen(true)}
        onChange={event => {
          setQuery(event.target.value)
          setOpen(true)
        }}
      />
      <kbd>⌘K</kbd>
      {open && query.trim().length >= 2 ? (
        <div className="searchmenu" id="global-search-results">
          {!results ? (
            <div className="searchstate">Searching…</div>
          ) : count === 0 ? (
            <div className="searchstate">No matches for “{query}”</div>
          ) : (
            <>
              {results.entries.length > 0 ? <div className="searchlabel">Content</div> : null}
              {results.entries.map(entry => (
                <button
                  type="button"
                  className="searchresult"
                  key={entry.id}
                  onClick={() => choose({ name: "editor", type: entry.type.name, id: entry.id })}
                >
                  <FileText size={14} />
                  <span>
                    <strong>{entry.title || "Untitled"}</strong>
                    <small>{entry.type.label}</small>
                  </span>
                  <Pill status={entry.status} />
                </button>
              ))}
              {results.media.length > 0 ? <div className="searchlabel">Media</div> : null}
              {results.media.map(item => (
                <button type="button" className="searchresult" key={item.id} onClick={() => choose({ name: "media" })}>
                  <ImageIcon size={14} />
                  <span>
                    <strong>{item.filename}</strong>
                    <small>{item.mime}</small>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

const ICONS: Record<string, typeof FileText> = {
  "shopping-bag": LayoutGrid,
  "corner-up-right": ListTree,
  inbox: Inbox,
  search: Search,
  settings: Settings,
}

// Changing your own password, which is the one account action nobody else can
// do for you: the Users screen deliberately hides "Reset password" on your own
// row, and an owner has nobody above them to ask. `POST /auth/password` proves
// the current password rather than trusting the session, so this collects it.
const ChangePassword = ({ onClose, toast }: { onClose: () => void; toast: (text: string, bad?: boolean) => void }) => {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [again, setAgain] = useState("")
  const [busy, setBusy] = useState(false)

  // Mirrors the server's rule (src/auth/index.ts) so the failure is immediate
  // rather than a round trip. The server still enforces it — this is courtesy.
  const tooShort = next.length > 0 && next.length < 12
  const mismatch = again.length > 0 && next !== again
  const ready = current.length > 0 && next.length >= 12 && next === again && !busy

  const submit = async () => {
    setBusy(true)
    try {
      await api.changePassword(current, next)
      toast("Password changed; your other sessions were signed out")
      onClose()
    } catch (error) {
      toast(errorOf(error), true)
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Change your password"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!ready} onClick={submit}>
            {busy ? "Changing" : "Change password"}
          </button>
        </>
      }
    >
      <Note kind="info">
        This signs out everywhere else you are logged in. The session you are using now stays open.
      </Note>
      <label className="f" style={{ marginTop: 14 }}>
        <span className="fl">Current password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={event => setCurrent(event.target.value)}
        />
      </label>
      <label className="f">
        <span className="fl">New password</span>
        <input
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={event => setNext(event.target.value)}
        />
        <span className="fh">At least 12 characters.</span>
      </label>
      <label className="f">
        <span className="fl">Confirm new password</span>
        <input
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={event => setAgain(event.target.value)}
          // Enter should submit a three-field form rather than needing the mouse.
          onKeyDown={event => {
            if (event.key === "Enter" && ready) void submit()
          }}
        />
      </label>
      {tooShort ? <Note kind="warn">New password must be at least 12 characters.</Note> : null}
      {mismatch ? <Note kind="warn">The two new passwords do not match.</Note> : null}
    </Modal>
  )
}

// ------------------------------------------------------------------------ ai

const brief = (value: unknown, length = 220): string => {
  if (value === null || value === undefined || value === "") return "—"
  const rendered = typeof value === "string" ? value : JSON.stringify(value)
  return rendered.length > length ? `${rendered.slice(0, length)}…` : rendered
}

type Change = { key: string; before: unknown; after: unknown }

// What the editor is being asked to approve, flattened out of whichever shape
// the proposal took. A content-model change is described by its field keys
// rather than its JSON, because "adds `subtitle`, drops `kicker`" is the part
// that decides whether the change is safe.
const changesIn = (proposal: AgentProposal): Change[] => {
  if (proposal.kind === "entry.create") {
    const data = (proposal.payload.data ?? {}) as Record<string, unknown>
    return [
      { key: "title", before: null, after: proposal.payload.title },
      ...Object.entries(data).map(([key, after]) => ({ key, before: null, after })),
    ]
  }

  if (proposal.kind === "type.update") {
    const keysOf = (raw: unknown): string[] =>
      Array.isArray(raw) ? raw.map(field => String((field as { key?: unknown }).key ?? "?")) : []
    const before = keysOf(proposal.before.fields)
    const after = keysOf(proposal.patch.fields)
    return [
      { key: "added", before: null, after: after.filter(key => !before.includes(key)).join(", ") || "nothing" },
      { key: "removed", before: null, after: before.filter(key => !after.includes(key)).join(", ") || "nothing" },
      { key: "order", before: before.join(" → "), after: after.join(" → ") },
    ]
  }

  const data = (proposal.patch.data ?? {}) as Record<string, unknown>
  const out: Change[] = []
  if (proposal.patch.title !== undefined) {
    out.push({ key: "title", before: proposal.before.title, after: proposal.patch.title })
  }
  if (proposal.patch.slug !== undefined) {
    out.push({ key: "slug", before: proposal.before.slug, after: proposal.patch.slug })
  }
  for (const [key, after] of Object.entries(data)) out.push({ key, before: proposal.before[key] ?? null, after })
  return out
}

const targetOf = (proposal: AgentProposal): string =>
  proposal.kind === "entry.update"
    ? proposal.entryTitle
    : proposal.kind === "entry.create"
      ? `New ${proposal.typeName}`
      : `${proposal.typeName} model`

const ProposalCard = ({
  proposal,
  decided,
  canApply,
  onApply,
  onDismiss,
}: {
  proposal: AgentProposal
  decided: "applied" | "dismissed" | undefined
  canApply: boolean
  onApply: () => void
  onDismiss: () => void
}) => (
  <div className={cx("proposal", decided)}>
    <div className="row">
      <div style={{ minWidth: 0 }}>
        <div className="proposalhead">{proposal.summary}</div>
        <div className="dim2" style={{ fontSize: 12 }}>
          {targetOf(proposal)}
        </div>
      </div>
      <div className="row rowend">
        {decided === "applied" ? (
          <span className="pill published">applied</span>
        ) : decided === "dismissed" ? (
          <span className="pill archived">dismissed</span>
        ) : (
          <>
            <button type="button" className="btn sm" onClick={onDismiss}>
              Dismiss
            </button>
            <button type="button" className="btn primary sm" disabled={!canApply} onClick={onApply}>
              <Check size={13} /> Apply
            </button>
          </>
        )}
      </div>
    </div>

    <table className="difftable">
      <tbody>
        {changesIn(proposal).map(change => (
          <tr key={change.key}>
            <td className="mono dim2">{change.key}</td>
            <td className="dim2 diffbefore">{brief(change.before)}</td>
            <td>{brief(change.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

// Turns and tool calls both carry an id because both are append-only lists
// whose entries are not distinguishable by content — the agent can call the
// same tool twice in one turn, and two questions can be worded identically.
const marker = (): string => Math.random().toString(36).slice(2, 10)

type Turn = { id: string; role: "you" | "agent"; text: string; tools: { id: string; name: string }[] }

const AgentPanel = ({
  canApply,
  toast,
  go,
}: {
  canApply: boolean
  toast: (message: string, bad?: boolean) => void
  go: (route: Route) => void
}) => {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.agentStatus>> | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [history, setHistory] = useState<unknown[]>([])
  const [proposals, setProposals] = useState<AgentProposal[]>([])
  const [decided, setDecided] = useState<Record<string, "applied" | "dismissed">>({})
  const [draft, setDraft] = useState("")
  const [running, setRunning] = useState(false)
  const tail = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api
      .agentStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  // Every delta replaces the turns array, so this follows the answer as it is
  // written rather than only when a turn ends — otherwise a long one scrolls
  // out of view mid-sentence. Nothing to follow before the first turn.
  useEffect(() => {
    if (turns.length > 0) tail.current?.scrollIntoView({ block: "end" })
  }, [turns])

  const send = async () => {
    const message = draft.trim()
    if (!message || running) return

    setDraft("")
    setTurns(current => [
      ...current,
      { id: marker(), role: "you", text: message, tools: [] },
      { id: marker(), role: "agent", text: "", tools: [] },
    ])
    setRunning(true)

    // The last turn is always the agent's, so every event folds into it.
    const onto = (change: (turn: Turn) => Turn) =>
      setTurns(current => current.map((turn, index) => (index === current.length - 1 ? change(turn) : turn)))

    try {
      await runAgent({ message, history }, event => {
        switch (event.type) {
          case "text":
            onto(turn => ({ ...turn, text: turn.text + event.text }))
            break
          case "tool":
            onto(turn => ({ ...turn, tools: [...turn.tools, { id: marker(), name: event.name }] }))
            break
          case "proposal":
            setProposals(current => [...current, event.proposal])
            break
          case "done":
            setHistory(event.history)
            break
          case "error":
            toast(event.message, true)
            break
        }
      })
    } catch (error) {
      toast(errorOf(error), true)
    } finally {
      setRunning(false)
      tail.current?.scrollIntoView({ block: "end", behavior: "smooth" })
    }
  }

  // Applying sends the change through the ordinary content routes — the same
  // ones the editor screens use — so it is validated, revisioned, and audited
  // as this user's edit rather than as something a machine did.
  const apply = async (proposal: AgentProposal) => {
    try {
      if (proposal.kind === "entry.update") await api.updateEntry(proposal.entryId, proposal.patch as Partial<Entry>)
      else if (proposal.kind === "entry.create")
        await api.createEntry(proposal.typeName, proposal.payload as Partial<Entry>)
      else await api.updateType(proposal.typeName, proposal.patch as Partial<ContentType>)

      setDecided(current => ({ ...current, [proposal.id]: "applied" }))
      toast("Change applied")
    } catch (error) {
      toast(errorOf(error), true)
    }
  }

  if (!status) return <Spinner />

  if (!status.configured)
    return (
      <Note kind="info">
        No AI provider is connected yet. Connect one under <strong>Providers</strong> and the agent turns on.
      </Note>
    )

  if (!status.supported)
    return (
      <Note kind="warn">
        The agent needs a provider that supports tool use, and {status.provider} is connected. The writing assistant in
        the entry editor still works.
      </Note>
    )

  if (!status.mayUse) return <Note kind="warn">Your role cannot use the assistant.</Note>

  const open = proposals.filter(proposal => !decided[proposal.id])

  return (
    <div className="agent">
      <div className="agentlog">
        {turns.length === 0 ? (
          <div className="agentintro">
            <Sparkles size={22} />
            <h3>Ask for a change</h3>
            <p className="dim2">
              The agent reads your content types, entries, and media, then proposes changes for you to review. Nothing
              is saved until you apply it.
            </p>
            <div className="agentseeds">
              {[
                "Which pages are missing a meta description?",
                "Rewrite the homepage hero to lead with what we actually do.",
                "Add an FAQ section to the page content type.",
              ].map(seed => (
                <button type="button" key={seed} className="btn sm" onClick={() => setDraft(seed)}>
                  {seed}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn, index) => (
            <div className={cx("turn", turn.role)} key={turn.id}>
              <div className="turnwho">{turn.role === "you" ? "You" : "Agent"}</div>
              {turn.tools.length > 0 ? (
                <div className="turntools">
                  {turn.tools.map(tool => (
                    <span className="mono" key={tool.id}>
                      {tool.name.replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="turntext">{turn.text || (running && index === turns.length - 1 ? "Working…" : "")}</div>
            </div>
          ))
        )}
        <div ref={tail} />
      </div>

      {proposals.length > 0 ? (
        <div className="proposals">
          <div className="row" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>Proposed changes</h3>
            {open.length > 1 && canApply ? (
              <button
                type="button"
                className="btn sm rowend"
                onClick={async () => {
                  for (const proposal of open) await apply(proposal)
                }}
              >
                Apply all
              </button>
            ) : null}
          </div>
          {!canApply ? <Note kind="warn">Your role cannot save content changes.</Note> : null}
          {proposals.map(proposal => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              decided={decided[proposal.id]}
              canApply={canApply}
              onApply={() => void apply(proposal)}
              onDismiss={() => setDecided(current => ({ ...current, [proposal.id]: "dismissed" }))}
            />
          ))}
          <p className="dim2" style={{ fontSize: 12 }}>
            Applied changes go through the same save an editor makes, so each one leaves a revision you can restore from
            the entry's history.
          </p>
        </div>
      ) : null}

      <div className="agentbar">
        <textarea
          value={draft}
          rows={2}
          placeholder="Ask the agent to change a page, draft one, or reshape a content type…"
          disabled={running}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send()
          }}
        />
        <button type="button" className="btn primary" disabled={running || !draft.trim()} onClick={() => void send()}>
          <Send size={14} /> {running ? "Working…" : "Send"}
        </button>
      </div>
      <p className="dim2" style={{ fontSize: 12 }}>
        {status.model} · ⌘↵ to send. The agent can read everything in this admin;{" "}
        <button type="button" className="linkish" onClick={() => go({ name: "activity" })}>
          every run is recorded in Activity
        </button>
        .
      </p>
    </div>
  )
}

const AiProviders = ({ toast }: { toast: (message: string, bad?: boolean) => void }) => {
  const [providers, setProviders] = useState<AiProvider[]>([])
  const [redirectUri, setRedirectUri] = useState("")
  const [items, setItems] = useState<AiCredential[]>([])
  const [busy, setBusy] = useState(true)
  const [choice, setChoice] = useState("anthropic")
  const [key, setKey] = useState("")
  const [model, setModel] = useState("")
  const [baseUrl, setBaseUrl] = useState("")

  const load = useCallback(async () => {
    const [catalog, credentials] = await Promise.all([api.aiProviders(), api.aiCredentials()])
    setProviders(catalog.data)
    setRedirectUri(catalog.redirectUri)
    setItems(credentials)
    setBusy(false)
  }, [])

  useEffect(() => {
    void load().catch(() => setBusy(false))
  }, [load])

  // The OAuth return leg drops the browser back here with an outcome in the
  // query string, since a redirect is the only channel it has. Reading it once
  // and clearing it keeps a refresh from repeating the message.
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const outcome = params.get("connected")
    if (!outcome) return
    toast(outcome === "ok" ? "Provider connected" : (params.get("reason") ?? "Could not connect"), outcome !== "ok")
    history.replaceState({}, "", location.pathname)
  }, [toast])

  const selected = providers.find(provider => provider.name === choice)

  if (busy) return <Spinner />

  return (
    <>
      <div className="card">
        <div className="cardbody">
          <h3 style={{ marginTop: 0 }}>Connected</h3>
          {items.length === 0 ? (
            <Empty title="Nothing connected" hint="The assistant and the agent stay off until a provider is here." />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Signed in as</th>
                  <th>Model</th>
                  <th>Last used</th>
                  <th style={{ width: 200 }} />
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.id}>
                    <td style={{ fontWeight: 550 }}>
                      {item.label}
                      {item.isDefault ? (
                        <span className="pill on" style={{ marginLeft: 8 }}>
                          default
                        </span>
                      ) : null}
                    </td>
                    <td className="dim2">
                      {item.authKind === "oauth" ? (item.account ?? "authorized account") : `key ${item.hint}`}
                    </td>
                    <td className="mono dim2">{item.model}</td>
                    <td className="dim2">{ago(item.lastUsedAt)}</td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          className="btn sm"
                          onClick={async () => {
                            try {
                              const result = await api.testAiCredential(item.id)
                              toast(
                                result.ok ? `${result.model} answered` : (result.error ?? "The provider refused"),
                                !result.ok,
                              )
                              await load()
                            } catch (error) {
                              toast(errorOf(error), true)
                            }
                          }}
                        >
                          Test
                        </button>
                        {item.isDefault ? null : (
                          <button
                            type="button"
                            className="btn sm"
                            onClick={async () => {
                              try {
                                await api.updateAiCredential(item.id, { isDefault: true })
                                await load()
                              } catch (error) {
                                toast(errorOf(error), true)
                              }
                            }}
                          >
                            Use this
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn danger sm"
                          onClick={async () => {
                            if (!confirm(`Disconnect ${item.label}? The assistant stops until another is connected.`))
                              return
                            try {
                              await api.deleteAiCredential(item.id)
                              await load()
                            } catch (error) {
                              toast(errorOf(error), true)
                            }
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="cardbody">
          <h3 style={{ marginTop: 0 }}>Connect a provider</h3>

          <label className="f">
            <span className="fl">Provider</span>
            <select
              value={choice}
              onChange={event => {
                setChoice(event.target.value)
                setKey("")
                setModel("")
                setBaseUrl("")
              }}
            >
              {providers.map(provider => (
                <option key={provider.name} value={provider.name}>
                  {provider.label}
                </option>
              ))}
            </select>
            <span className="fh">{selected?.help}</span>
          </label>

          {selected?.oauth ? (
            <div className="connectrow">
              <button
                type="button"
                className="btn primary"
                onClick={async () => {
                  try {
                    const started = await api.startAiOauth(selected.name)
                    location.assign(started.url)
                  } catch (error) {
                    toast(errorOf(error), true)
                  }
                }}
              >
                <ExternalLink size={14} /> Continue with {selected.label}
              </button>
              <span className="dim2">
                Authorize an account instead of storing a key. You can come back and revoke it at any time.
              </span>
            </div>
          ) : null}

          {selected?.oauth ? <div className="or">or</div> : null}

          {selected?.needsKey ? (
            <label className="f">
              <span className="fl">API key</span>
              <input
                type="password"
                value={key}
                autoComplete="off"
                placeholder="sk-…"
                onChange={event => setKey(event.target.value)}
              />
              <span className="fh">
                Stored encrypted and never shown again. Rotating SECRET invalidates it, the same way it invalidates
                sessions.
              </span>
            </label>
          ) : null}

          {selected?.needsBaseUrl ? (
            <label className="f">
              <span className="fl">Base URL</span>
              <input
                value={baseUrl}
                placeholder="http://127.0.0.1:11434"
                onChange={event => setBaseUrl(event.target.value)}
              />
            </label>
          ) : null}

          <label className="f">
            <span className="fl">Model</span>
            <input
              value={model}
              placeholder={selected?.defaultModel}
              list={`models-${choice}`}
              onChange={event => setModel(event.target.value)}
            />
            <datalist id={`models-${choice}`}>
              {(selected?.models ?? []).map(name => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <span className="fh">Leave blank for {selected?.defaultModel}. Newer models can be typed in.</span>
          </label>

          <button
            type="button"
            className="btn primary"
            disabled={(selected?.needsKey ?? false) && key.trim().length < 8}
            onClick={async () => {
              try {
                await api.connectAiKey({
                  provider: choice,
                  key: key.trim() || undefined,
                  model: model.trim() || undefined,
                  baseUrl: baseUrl.trim() || undefined,
                })
                setKey("")
                toast("Provider connected")
                await load()
              } catch (error) {
                toast(errorOf(error), true)
              }
            }}
          >
            Connect with a key
          </button>
        </div>
      </div>

      <div className="card">
        <div className="cardbody">
          <h3 style={{ marginTop: 0 }}>Using OAuth</h3>
          <p className="dim2">
            An OAuth button appears above only for providers this install has a registered client for. Register one with
            the provider using the redirect URI below, then set{" "}
            <span className="mono">AI_OAUTH_&lt;PROVIDER&gt;_CLIENT_ID</span> (and a secret, if the provider issues one)
            in your environment. There is no shared client a self-hosted CMS could ship — a redirect URI has to be
            registered against your own domain.
          </p>
          <div className="connectrow">
            <code className="mono">{redirectUri}</code>
            <button
              type="button"
              className="btn sm"
              onClick={async () => {
                await navigator.clipboard.writeText(redirectUri).catch(() => {})
                toast("Redirect URI copied")
              }}
            >
              <Copy size={13} /> Copy
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

const AiScreen = ({
  role,
  toast,
  go,
}: {
  role: string
  toast: (message: string, bad?: boolean) => void
  go: (route: Route) => void
}) => {
  const mayManage = hasRole(role, "admin")
  // An operator arriving from an OAuth redirect should land on the tab that
  // shows them what happened, not on the agent.
  const [tab, setTab] = useState<"agent" | "providers">(
    mayManage && new URLSearchParams(location.search).has("connected") ? "providers" : "agent",
  )

  return (
    <>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <h1>AI</h1>
          <p className="dim2">An assistant that knows this site's content, and the provider it runs on.</p>
        </div>
      </div>

      {mayManage ? (
        <div className="tabs">
          <button type="button" className={cx("tab", tab === "agent" && "on")} onClick={() => setTab("agent")}>
            Agent
          </button>
          <button type="button" className={cx("tab", tab === "providers" && "on")} onClick={() => setTab("providers")}>
            Providers
          </button>
        </div>
      ) : null}

      {tab === "providers" && mayManage ? (
        <AiProviders toast={toast} />
      ) : (
        <AgentPanel canApply={hasRole(role, "author")} toast={toast} go={go} />
      )}
    </>
  )
}

const App = () => {
  const [me, setMe] = useState<Identity | null>(null)
  const [booted, setBooted] = useState(false)
  const [types, setTypes] = useState<ContentType[]>([])
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [route, go] = useRoute()
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null)
  const [changingPassword, setChangingPassword] = useState(false)

  const toast = useCallback((text: string, bad = false) => {
    setMessage({ text, bad })
    setTimeout(() => setMessage(null), 3200)
  }, [])

  const loadWorkspace = useCallback(async () => {
    const [nextTypes, nextPlugins] = await Promise.all([api.types().catch(() => []), api.plugins().catch(() => [])])
    setTypes(nextTypes)
    setPlugins(nextPlugins)
  }, [])

  useEffect(() => {
    if (!getToken()) {
      setBooted(true)
      return
    }
    api
      .me()
      .then(identity => {
        setMe(identity)
        void loadWorkspace()
      })
      .catch(() => clearToken())
      .finally(() => setBooted(true))
  }, [loadWorkspace])

  if (!booted) return <Spinner />

  if (!me)
    return (
      <Login
        onDone={identity => {
          setMe(identity)
          void loadWorkspace()
        }}
      />
    )

  const collections = types.filter(t => !t.ownerPlugin || t.kind === "collection")
  const enabledPlugins = plugins.filter(p => p.enabled && p.panels.length > 0)

  const nav = (target: Route, label: string, Icon: typeof FileText, count?: number) => {
    const on =
      route.name === target.name &&
      (target.name !== "collection" || (route as { type: string }).type === target.type) &&
      (target.name !== "plugin" || (route as { plugin: string }).plugin === (target as { plugin: string }).plugin)
    return (
      <button type="button" key={label} className={cx("navitem", on && "on")} onClick={() => go(target)}>
        <Icon size={15} />
        <span>{label}</span>
        {count !== undefined ? <span className="navcount">{count}</span> : null}
      </button>
    )
  }

  const screen = (() => {
    switch (route.name) {
      case "collection": {
        const type = types.find(t => t.name === route.type)
        return type ? (
          <Collection type={type} canWrite={hasRole(me.role, "author")} go={go} />
        ) : (
          <Note kind="warn">That content type no longer exists.</Note>
        )
      }
      case "editor": {
        const type = types.find(t => t.name === route.type)
        return type ? (
          <Editor
            type={type}
            id={route.id}
            canEdit={hasRole(me.role, "author")}
            canPublish={hasRole(me.role, "editor")}
            identityId={me.id}
            go={go}
            toast={toast}
          />
        ) : (
          <Note kind="warn">That content type no longer exists.</Note>
        )
      }
      case "media":
        return <MediaLibrary canManage={hasRole(me.role, "author")} toast={toast} />
      case "types":
        if (!hasRole(me.role, "admin")) return <Note kind="warn">An admin manages content types.</Note>
        return <TypesScreen types={types} editing={route.type} go={go} onChanged={loadWorkspace} toast={toast} />
      case "taxonomy":
        if (!hasRole(me.role, "editor")) return <Note kind="warn">An editor manages categories.</Note>
        return <TaxonomiesScreen toast={toast} />
      case "menus":
        if (!hasRole(me.role, "editor")) return <Note kind="warn">An editor manages menus.</Note>
        return <MenusScreen toast={toast} />
      case "trash":
        if (!hasRole(me.role, "author")) return <Note kind="warn">Your role cannot restore deleted content.</Note>
        return (
          <TrashScreen
            types={types}
            canPurgeEntries={hasRole(me.role, "editor")}
            canPurgeMedia={hasRole(me.role, "admin")}
            toast={toast}
          />
        )
      case "webhooks":
        if (!hasRole(me.role, "admin")) return <Note kind="warn">An admin manages webhooks.</Note>
        return <WebhooksScreen toast={toast} />
      case "activity":
        if (!hasRole(me.role, "admin")) return <Note kind="warn">An admin can view site activity.</Note>
        return <ActivityScreen />
      case "plugins":
        if (!hasRole(me.role, "admin")) return <Note kind="warn">An admin manages plugins.</Note>
        return (
          <Plugins
            go={go}
            toast={(text, bad) => {
              toast(text, bad)
              void loadWorkspace()
            }}
          />
        )
      case "plugin": {
        if (!hasRole(me.role, "admin")) return <Note kind="warn">An admin manages plugin settings.</Note>
        const plugin = plugins.find(p => p.name === route.plugin)
        const panel = plugin?.panels.find(p => p.id === route.panel)
        if (!plugin || !panel) return <Note kind="warn">That plugin panel is not available.</Note>
        return <PluginPanelView plugin={plugin} panel={panel} types={types} go={go} toast={toast} />
      }
      case "settings":
        if (!hasRole(me.role, "admin")) return <Note kind="warn">An admin manages site settings.</Note>
        return <SettingsScreen toast={toast} />
      case "keys":
        if (!hasRole(me.role, "admin")) return <Note kind="warn">An admin manages API keys.</Note>
        return <Keys types={types} toast={toast} />
      case "users":
        if (!hasRole(me.role, "admin")) return <Note kind="warn">An admin manages users.</Note>
        return <UsersScreen me={me} toast={toast} />
      case "ai":
        if (!hasRole(me.role, "author")) return <Note kind="warn">Your role cannot use the assistant.</Note>
        return <AiScreen role={me.role} toast={toast} go={go} />
      default:
        return <Dashboard go={go} />
    }
  })()

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <div className="brandmark">I</div>
          <span>Inkling</span>
        </div>

        <div className="navgroup">
          {nav({ name: "dashboard" }, "Dashboard", LayoutGrid)}
          {nav({ name: "media" }, "Media", ImageIcon)}
          {hasRole(me.role, "author") ? nav({ name: "ai" }, "AI", Sparkles) : null}
          {hasRole(me.role, "author") ? nav({ name: "trash" }, "Trash", Trash2) : null}
        </div>

        {collections.length > 0 ? (
          <div className="navgroup">
            <div className="navlabel">Content</div>
            {collections.map(type => nav({ name: "collection", type: type.name }, type.pluralLabel, FileText))}
          </div>
        ) : null}

        {enabledPlugins.length > 0 ? (
          <div className="navgroup">
            <div className="navlabel">Plugins</div>
            {enabledPlugins.flatMap(plugin =>
              plugin.panels
                // Collection panels already appear under Content.
                .filter(panel => panel.kind !== "collection")
                .map(panel =>
                  nav(
                    { name: "plugin", plugin: plugin.name, panel: panel.id },
                    panel.label,
                    ICONS[panel.icon ?? ""] ?? Blocks,
                  ),
                ),
            )}
          </div>
        ) : null}

        <div className="navgroup">
          {hasRole(me.role, "editor") ? <div className="navlabel">Configure</div> : null}
          {hasRole(me.role, "admin") ? nav({ name: "types" }, "Content types", Shapes) : null}
          {hasRole(me.role, "editor") ? nav({ name: "taxonomy" }, "Categories", ListTree) : null}
          {hasRole(me.role, "editor") ? nav({ name: "menus" }, "Menus", MenuIcon) : null}
          {hasRole(me.role, "admin")
            ? nav({ name: "plugins" }, "Plugins", Blocks, plugins.filter(p => p.enabled).length)
            : null}
          {hasRole(me.role, "admin") ? nav({ name: "keys" }, "API keys", Key) : null}
          {hasRole(me.role, "admin") ? nav({ name: "webhooks" }, "Webhooks", WebhookIcon) : null}
          {hasRole(me.role, "admin") ? nav({ name: "activity" }, "Activity", Activity) : null}
          {hasRole(me.role, "admin") ? nav({ name: "users" }, "Users", Users) : null}
          {hasRole(me.role, "admin") ? nav({ name: "settings" }, "Settings", Settings) : null}
        </div>

        <div className="sidefoot">
          <div className="who">
            <div className="avatar">{initials(me.name)}</div>
            <div style={{ minWidth: 0 }}>
              <div className="whoname">{me.name}</div>
              <div className="whorole">{me.role}</div>
            </div>
            <button
              type="button"
              className="btn ghost sm rowend"
              aria-label="Change password"
              title="Change password"
              onClick={() => setChangingPassword(true)}
            >
              <Lock size={14} />
            </button>
            <button
              type="button"
              className="btn ghost sm"
              aria-label="Sign out"
              title="Sign out"
              onClick={async () => {
                await api.logout().catch(() => {})
                clearToken()
                setMe(null)
              }}
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="top">
          <GlobalSearch go={go} />
          <div className="topspacer" />
        </header>
        <div className="body">{screen}</div>
      </main>

      {changingPassword ? <ChangePassword onClose={() => setChangingPassword(false)} toast={toast} /> : null}

      {message ? <div className={cx("toast", message.bad && "bad")}>{message.text}</div> : null}
    </div>
  )
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<App />)
