import { ArrowDown, ArrowUp, Eye, EyeOff, Monitor, Smartphone } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { api, type ContentType, type Entry, type Field, type VisualPage } from "../api.ts"
import { FormattedInput } from "../formatted/index.tsx"
import { Canvas, type Selection } from "./canvas.tsx"
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
  openShared,
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
  openShared: (id?: string) => void
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

  useEffect(() => {
    let active = true
    const abort = new AbortController()
    setLoading(true)
    if (retry > 0) setFailure("")
    const timer = setTimeout(async () => {
      try {
        const link = await api.previewEntry(entry.id, JSON.parse(snapshot))
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
        if (active) setFailure(error instanceof Error ? error.message : "The preview could not load.")
      } finally {
        if (active) setLoading(false)
      }
    }, 450)
    return () => {
      active = false
      clearTimeout(timer)
      abort.abort()
    }
  }, [entry.id, snapshot, retry])

  const select = (next: Selection) => {
    if (next.shared) {
      openShared(next.shared)
      return
    }
    const parent = definition.sections.find(item => item.id === next.section || item.fields.includes(next.field ?? ""))
    setSelected({ ...next, section: parent?.id })
    setTab("content")
    if (next.field)
      requestAnimationFrame(() => document.getElementById(`visual-${next.field}`)?.scrollIntoView({ block: "nearest" }))
  }
  const move = (id: string, amount: number) => {
    const next = sections.map(section => section.id)
    const index = next.indexOf(id)
    const swap = next[index + amount]
    if (!swap) return
    next[index] = swap
    next[index + amount] = id
    edit("__layout", { order: next, hidden })
  }
  const toggle = (id: string) =>
    edit("__layout", {
      order: sections.map(section => section.id),
      hidden: hidden.includes(id) ? hidden.filter(key => key !== id) : [...hidden, id],
    })

  return (
    <div className="visualeditor">
      <div className="visualstage">
        <div className="visualtools">
          <span className="visualhint">Click text or a picture to edit</span>
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
              phone={phone}
              labels={{
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
      <aside className="visualinspector" aria-label="Page editing controls">
        {website?.parts.length ? (
          <button type="button" className="btn visualshared" onClick={() => openShared()}>
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
                  This section uses content managed elsewhere on your site. Select another section to edit its words or
                  pictures.
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
              <ol className="visualsections">
                {sections.map((item, index) => (
                  <li key={item.id}>
                    <button type="button" className="visualsectionname" onClick={() => select({ section: item.id })}>
                      {item.label}
                      <small>{hidden.includes(item.id) ? "Hidden from visitors" : "Visible"}</small>
                    </button>
                    <div className="row">
                      <button
                        type="button"
                        className="btn ghost sm"
                        aria-label={`Move ${item.label} up`}
                        disabled={index === 0 || item.movable === false || sections[index - 1]?.movable === false}
                        onClick={() => move(item.id, -1)}
                      >
                        <ArrowUp size={15} />
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        aria-label={`Move ${item.label} down`}
                        disabled={
                          index === sections.length - 1 ||
                          item.movable === false ||
                          sections[index + 1]?.movable === false
                        }
                        onClick={() => move(item.id, 1)}
                      >
                        <ArrowDown size={15} />
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        aria-label={`${hidden.includes(item.id) ? "Show" : "Hide"} ${item.label}`}
                        onClick={() => toggle(item.id)}
                      >
                        {hidden.includes(item.id) ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </fieldset>
        <div className="visualactions">{actions}</div>
      </aside>
    </div>
  )
}
