import { Monitor, Smartphone } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api, type ContentType, type Entry, type Field, type VisualPage } from "../api.ts"
import { FormattedInput } from "../formatted/index.tsx"
import { askTarget, selectTarget } from "../inkystore.ts"
import { sharedPatch } from "../website/content.ts"
import { type SharedInputs, SharedInspector } from "../website/inspector.tsx"
import { useSharedContent } from "../website/state.ts"
import "../website/style.css"
import { Canvas, type Selection } from "./canvas.tsx"
import { reorderSections } from "./order.ts"
import { Sections } from "./sections.tsx"
import { focusControl } from "./selection.ts"
import "./style.css"

type Layout = { order: string[]; hidden: string[] }

export const VisualEditor = ({
  entry,
  type,
  definition,
  title,
  slug,
  data,
  errors,
  disabled,
  edit,
  renderField,
  actions,
  openCollection,
  sharedInputs,
  role,
  onSharedState,
  onSharedSaved,
}: {
  entry: Entry
  type: ContentType
  definition: VisualPage
  title: string
  slug: string
  data: Record<string, unknown>
  errors: Record<string, string>
  disabled: boolean
  edit: (key: string, value: unknown) => void
  renderField: (field: Field) => ReactNode
  actions: ReactNode
  sharedInputs: SharedInputs
  role: string
  onSharedState: (dirty: boolean, saving: boolean) => void
  onSharedSaved: (entryId: string, values: Record<string, unknown>) => void
  openCollection: (type: string) => void
}) => {
  const [website, setWebsite] = useState<Awaited<ReturnType<typeof api.website>> | null>(null)
  useEffect(() => {
    void api
      .website()
      .then(setWebsite)
      .catch(() => {})
  }, [])
  const [selected, setSelected] = useState<Selection>({ section: definition.sections[0]?.id })
  const part = website?.parts.find(item => item.id === selected.shared)
  const shared = useSharedContent(part, disabled)
  const [pending, setPending] = useState<{ selection: Selection; focus: boolean } | null>(null)
  const focusSelection = useRef(false)
  useEffect(() => {
    onSharedState(shared.dirty, shared.saving)
  }, [shared.dirty, shared.saving, onSharedState])
  useEffect(() => () => onSharedState(false, false), [onSharedState])
  useEffect(() => {
    const next = focusSelection.current ? selected : null
    if (!next || disabled || shared.saving || (next.shared && !shared.loaded)) return
    const frame = requestAnimationFrame(() => {
      focusSelection.current = false
      focusControl(
        next.shared
          ? document.querySelector(".sharedinspector .visualcontrols")
          : next.field
            ? document.getElementById(`visual-${next.field}`)
            : document.querySelector(".visualcontrols"),
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [selected, shared.loaded, shared.saving, disabled])
  const [tab, setTab] = useState<"content" | "sections">("content")
  const [phone, setPhone] = useState(false)
  const [preview, setPreview] = useState<{ html: string; url: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState("")
  const [retry, setRetry] = useState(0)
  const snapshot = useMemo(() => JSON.stringify({ title, slug, data }), [title, slug, data])
  const layout = data.__layout as Layout | undefined
  const order = [...new Set([...(layout?.order ?? []), ...definition.sections.map(section => section.id)])]
  const sections = order.flatMap(id => definition.sections.find(section => section.id === id) ?? [])
  const hidden = layout?.hidden ?? []
  const section = definition.sections.find(item => item.id === selected.section)
  const fieldKeys = section?.fields ?? type.fields.map(field => field.key)
  const fields = fieldKeys.flatMap(key => {
    if (key === "$title") return { key, label: "Title", type: "text" }
    return type.fields.find(field => field.key === key) ?? []
  })
  const targetFor = useCallback(
    (next: Selection) => {
      const shared = website?.parts.find(part => part.id === next.shared)
      if (shared) return { label: shared.label, shared: shared.id }
      const group = definition.sections.find(part => part.id === next.section || part.fields.includes(next.field ?? ""))
      const label = next.field === "$title" ? "Page title" : type.fields.find(field => field.key === next.field)?.label
      return {
        label: label ?? group?.label ?? entry.title,
        entryId: entry.id,
        type: type.name,
        field: next.field,
        section: group?.id,
      }
    },
    [website, definition, type.fields, type.name, entry.id, entry.title],
  )
  useEffect(() => {
    selectTarget(targetFor(selected))
    return () => selectTarget(null)
  }, [selected, targetFor])

  useEffect(() => {
    let active = true
    const abort = new AbortController()
    setLoading(true)
    if (retry > 0) setFailure("")
    const timer = setTimeout(async () => {
      const timeout = setTimeout(() => abort.abort(), 15000)
      try {
        const link = await api.previewEntry(entry.id, JSON.parse(snapshot), abort.signal)
        if (!active) return
        if (!link.siteUrl) throw new Error("This page does not have a preview address yet.")
        const url = new URL(link.siteUrl, location.origin)
        if (url.origin !== location.origin)
          throw new Error(
            "Visual editing needs the page and editor on the same site. Use All fields to edit this page.",
          )
        url.searchParams.set("visual", "1")
        const response = await fetch(url, { signal: abort.signal, cache: "no-store" })
        if (!response.ok) throw new Error("The page preview could not load. Your edits are still here.")
        const html = await response.text()
        if (!html.includes("data-inkling-"))
          throw new Error("This page's editing controls are not connected yet. Use All fields to keep editing.")
        if (active) {
          setPreview({ html, url: url.href })
          setFailure("")
        }
      } catch (error) {
        if (active)
          setFailure(
            abort.signal.aborted
              ? "The preview took too long. Your edits are still here. Try again."
              : error instanceof Error
                ? error.message
                : "The preview could not load.",
          )
      } finally {
        clearTimeout(timeout)
        if (active) setLoading(false)
      }
    }, 450)
    return () => {
      active = false
      clearTimeout(timer)
      abort.abort()
    }
  }, [entry.id, snapshot, retry])

  const openSelection = (next: Selection, focus = false) => {
    setPending(null)
    focusSelection.current = focus
    const parent = definition.sections.find(item => item.id === next.section || item.fields.includes(next.field ?? ""))
    setSelected({ ...next, section: parent?.id })
    setTab("content")
    requestAnimationFrame(() => {
      if (!focus && next.field) document.getElementById(`visual-${next.field}`)?.scrollIntoView({ block: "nearest" })
    })
  }
  const select = (next: Selection, focus = false) => {
    if (shared.saving) return
    if (part && shared.dirty && next.shared !== part.id) setPending({ selection: next, focus })
    else openSelection(next, focus)
  }
  const saveShared = async () => {
    if (!(await shared.save())) return false
    if (part?.source.kind === "entry" && shared.loaded?.entry) {
      const values = sharedPatch(part, shared.loaded, shared.values)
      onSharedSaved(shared.loaded.entry.id, values)
    }
    setRetry(value => value + 1)
    return true
  }
  const move = (id: string, amount: number) => {
    if (disabled) return
    const index = sections.findIndex(section => section.id === id)
    const order = reorderSections(sections, id, sections[index + amount]?.id ?? "")
    if (order) edit("__layout", { order, hidden })
  }
  const toggle = (id: string) =>
    edit("__layout", {
      order: sections.map(section => section.id),
      hidden: hidden.includes(id) ? hidden.filter(key => key !== id) : [...hidden, id],
    })
  const editSelection = (next: Selection) => select(next, true)

  return (
    <div className={part ? "visualeditor editingshared" : "visualeditor"}>
      <div className="visualstage">
        <div className="visualtools">
          <span className="visualhint">Double-click to edit · Right-click for actions</span>
          <fieldset className="row visualsize" aria-label="Preview size">
            <button
              type="button"
              className="btn ghost sm"
              aria-label="Desktop preview"
              aria-pressed={!phone}
              onClick={() => setPhone(false)}
            >
              <Monitor size={17} />
            </button>
            <button
              type="button"
              className="btn ghost sm"
              aria-label="Phone preview"
              aria-pressed={phone}
              onClick={() => setPhone(true)}
            >
              <Smartphone size={17} />
            </button>
          </fieldset>
        </div>
        <div className="visualstatus" role="status">
          {failure ? (
            <>
              <span>{failure}</span>
              <button type="button" className="btn sm" onClick={() => setRetry(value => value + 1)}>
                Try preview again
              </button>
            </>
          ) : loading ? (
            "Updating preview…"
          ) : entry.status === "published" ? (
            "Preview only. Your website changes when you save."
          ) : (
            "Preview only. Save to keep your changes in Inkling."
          )}
        </div>
        <div className="visualcanvas" aria-busy={loading}>
          {preview ? (
            <Canvas
              {...preview}
              parts={website?.parts}
              selected={selected}
              onSelect={select}
              onEdit={editSelection}
              onAsk={(selection, anchor, restore) => askTarget(targetFor(selection), anchor, restore)}
              actions={selection => {
                if (selection.shared) return []
                const item = sections.find(
                  item => item.id === selection.section || item.fields.includes(selection.field ?? ""),
                )
                if (!item) return []
                const index = sections.indexOf(item)
                const collection = item.collection
                return [
                  ...(collection
                    ? [{ label: `Open ${collection.label}`, run: () => openCollection(collection.type) }]
                    : []),
                  {
                    label: "Move section up",
                    disabled:
                      disabled || index === 0 || item.movable === false || sections[index - 1]?.movable === false,
                    run: () => move(item.id, -1),
                  },
                  {
                    label: "Move section down",
                    disabled:
                      disabled ||
                      index === sections.length - 1 ||
                      item.movable === false ||
                      sections[index + 1]?.movable === false,
                    run: () => move(item.id, 1),
                  },
                  {
                    label: hidden.includes(item.id) ? "Show section" : "Hide section",
                    disabled,
                    run: () => toggle(item.id),
                  },
                ]
              }}
              phone={phone}
              labels={{
                ...Object.fromEntries(definition.sections.map(section => [section.id, section.label])),
                $title: "Title",
                ...Object.fromEntries(
                  type.fields.map(field => [field.key, definition.references?.[field.key]?.label ?? field.label]),
                ),
              }}
            />
          ) : (
            <div className="visualempty">
              {failure ? "Your edits are safe. You can continue using the controls." : "Loading your page…"}
            </div>
          )}
        </div>
      </div>
      {part ? (
        <SharedInspector
          part={part}
          state={shared}
          role={role}
          disabled={disabled}
          save={saveShared}
          {...sharedInputs}
          before={
            <button
              type="button"
              className="btn visualshared"
              onClick={() => select({ section: definition.sections[0]?.id })}
            >
              Back to page content
            </button>
          }
          switching={
            pending
              ? {
                  label: targetFor(pending.selection).label.toLowerCase(),
                  accept: () => openSelection(pending.selection, pending.focus),
                  cancel: () => setPending(null),
                }
              : null
          }
        />
      ) : (
        <aside className="visualinspector" aria-label="Page editing controls">
          {website?.parts.length ? (
            <button type="button" className="btn visualshared" onClick={() => select({ shared: website.parts[0]?.id })}>
              Header, footer & shared details
            </button>
          ) : null}
          <fieldset className="visualtabs" aria-label="Editing controls">
            <button type="button" aria-pressed={tab === "content"} onClick={() => setTab("content")}>
              Content
            </button>
            <button type="button" aria-pressed={tab === "sections"} onClick={() => setTab("sections")}>
              Sections
            </button>
          </fieldset>
          <fieldset className="visualcontrols" disabled={disabled}>
            {tab === "content" ? (
              <>
                <label className="f">
                  <span className="fl">Editing</span>
                  <select value={selected.section ?? ""} onChange={event => select({ section: event.target.value })}>
                    <option value="">All content</option>
                    {sections.map(item => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                        {hidden.includes(item.id) ? " (hidden)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {section && hidden.includes(section.id) ? (
                  <p className="visualnotice">This section is hidden on your website. Show it again under Sections.</p>
                ) : null}
                {section?.collection ? (
                  <div className="visualrelated">
                    <p>To change the items shown here:</p>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        if (section.collection) openCollection(section.collection.type)
                      }}
                    >
                      Open {section.collection.label}
                    </button>
                  </div>
                ) : null}
                {fields.length ? (
                  fields.map(field => (
                    <div
                      key={field.key}
                      id={`visual-${field.key}`}
                      className={selected.field === field.key ? "visualfield selected" : "visualfield"}
                    >
                      {definition.formatted?.includes(field.key) ? (
                        <div className="f">
                          <span className="fl">{field.label}</span>
                          <FormattedInput
                            id={`f-${field.key}`}
                            label={field.label}
                            value={String(data[field.key] ?? "")}
                            disabled={disabled}
                            onChange={value => edit(field.key, value)}
                          />
                        </div>
                      ) : (
                        renderField(field)
                      )}
                      {errors[field.key] ? <span className="visualerror">{errors[field.key]}</span> : null}
                    </div>
                  ))
                ) : (
                  <p className="dim">
                    This section uses content managed elsewhere on your site. Select another section to edit its words
                    or pictures.
                  </p>
                )}
              </>
            ) : (
              <>
                <h3>Page sections</h3>
                <p className="dim">
                  Move sections up or down, or hide them from visitors.{" "}
                  {entry.status === "published"
                    ? "Save to update your website."
                    : "Save to keep these changes. Publish when you’re ready."}
                </p>
                <Sections
                  sections={sections}
                  hidden={hidden}
                  disabled={disabled}
                  select={id => select({ section: id })}
                  reorder={order => edit("__layout", { order, hidden })}
                  toggle={toggle}
                />
              </>
            )}
          </fieldset>
          <div className="visualactions">{actions}</div>
        </aside>
      )}
    </div>
  )
}
