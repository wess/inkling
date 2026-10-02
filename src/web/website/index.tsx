import { Monitor, Smartphone } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import type { Website } from "../../website/index.ts"
import { api, type Field, type MenuItem } from "../api.ts"
import { Canvas } from "../visual/canvas.tsx"
import { loadPart, type SharedContent, savePart } from "./content.ts"
import "./style.css"

export const SharedScreen = ({
  partId,
  role,
  onSelect,
  renderField,
  renderMenu,
  fallback,
}: {
  partId?: string
  role: string
  onSelect: (id: string) => void
  renderField: (field: Field, value: unknown, change: (value: unknown) => void) => ReactNode
  renderMenu: (items: MenuItem[], change: (items: MenuItem[]) => void) => ReactNode
  fallback: ReactNode
}) => {
  const [website, setWebsite] = useState<Website | null>(null)
  const [content, setLoaded] = useState<(SharedContent & { partId: string }) | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [failure, setFailure] = useState("")
  const [previewFailure, setPreviewFailure] = useState("")
  const [preview, setPreview] = useState<{ html: string; url: string } | null>(null)
  const [revision, setRevision] = useState(0)
  const [phone, setPhone] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState("")
  const lock = useRef(false)
  const part = website?.parts.find(item => item.id === partId) ?? website?.parts[0]
  const loaded = content?.partId === part?.id ? content : null
  const mayEdit =
    part?.source.kind === "settings" ? ["owner", "admin"].includes(role) : ["owner", "admin", "editor"].includes(role)

  useEffect(() => {
    void api
      .website()
      .then(setWebsite)
      .catch(error => setFailure(error.message))
  }, [])
  useEffect(() => {
    let active = true
    setLoaded(null)
    setFailure("")
    setSaved("")
    setDirty(false)
    if (part)
      void loadPart(part)
        .then(result => {
          if (!active) return
          setLoaded({ ...result, partId: part.id })
          setValues(result.values)
        })
        .catch(error => {
          if (active) setFailure(error.message)
        })
    return () => {
      active = false
    }
  }, [part])
  useEffect(() => {
    document.body.dataset.unsaved = dirty ? "true" : "false"
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault()
    }
    addEventListener("beforeunload", leave)
    return () => {
      delete document.body.dataset.unsaved
      removeEventListener("beforeunload", leave)
    }
  }, [dirty])
  useEffect(() => {
    if (!website?.parts.length) return
    const abort = new AbortController()
    const load = async () => {
      try {
        const url = new URL(website.previewUrl, location.origin)
        if (url.origin !== location.origin)
          throw new Error("The preview needs to be on the same website as this editor.")
        if (revision) url.searchParams.set("_inklingpreview", String(revision))
        const response = await fetch(url, { cache: "no-store", signal: abort.signal })
        if (!response.ok || !response.headers.get("content-type")?.includes("text/html"))
          throw new Error("The website preview could not load. You can still edit the controls.")
        const html = await response.text()
        if (!abort.signal.aborted) {
          setPreview({ html, url: url.href })
          setPreviewFailure("")
        }
      } catch (error) {
        if (!abort.signal.aborted) setPreviewFailure((error as Error).message)
      }
    }
    void load()
    return () => abort.abort()
  }, [website, revision])

  const edit = (key: string, value: unknown) => {
    setValues(current => ({ ...current, [key]: value }))
    setDirty(true)
    setSaved("")
  }
  const save = async () => {
    if (!part || !loaded || lock.current) return
    lock.current = true
    setSaving(true)
    setFailure("")
    try {
      await savePart(part, loaded, values)
      setLoaded({ ...loaded, values, menuExists: true })
      setDirty(false)
      setSaved(
        loaded.entry && loaded.entry.status !== "published"
          ? "Saved in Inkling. These details are not published yet."
          : "Saved. These details are now updated across your website.",
      )
      setRevision(value => value + 1)
    } catch (error) {
      setFailure((error as Error).message)
    } finally {
      lock.current = false
      setSaving(false)
    }
  }

  return (
    <div className="sharedscreen">
      <header>
        <h1>Header, footer & shared details</h1>
        <p className="dim">
          Edit the parts that appear across your website. Choose a part below or click it in the preview.
        </p>
      </header>
      {website?.parts.length === 0 ? (
        <div className="note">Shared editing has not been connected for this website yet. {fallback}</div>
      ) : null}
      <nav className="sharedparts" aria-label="Shared website parts">
        {website?.parts.map(item => (
          <button
            key={item.id}
            type="button"
            className="btn"
            aria-pressed={part?.id === item.id}
            disabled={saving}
            onClick={() => onSelect(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {part ? (
        <div className="visualeditor">
          <div className="visualstage">
            <div className="visualtools">
              <span className="visualhint">Your website now</span>
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
              {previewFailure || "The preview updates after you save."}
            </div>
            <div className="visualcanvas">
              {preview ? (
                <Canvas
                  {...preview}
                  parts={website?.parts}
                  selected={{ shared: part.id }}
                  onSelect={selection => {
                    if (selection.shared && !saving) onSelect(selection.shared)
                  }}
                  phone={phone}
                  labels={{}}
                />
              ) : (
                <div className="visualempty">{previewFailure || "Loading your website…"}</div>
              )}
            </div>
          </div>
          <aside className="visualinspector" aria-label="Shared website editing controls">
            <div className="sharedintro">
              <h2>{part.label}</h2>
              <p>{part.description}</p>
              <p className="dim">Changes apply everywhere this part appears.</p>
            </div>
            {failure ? (
              <div className="note err" role="alert">
                {failure}
                {!loaded ? (
                  <button type="button" className="btn" onClick={() => location.reload()}>
                    Reload controls
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="visualactions">
              <p role="status">{saved || (dirty ? "Unsaved changes" : "No unsaved changes")}</p>
              <button
                type="button"
                className="btn primary"
                disabled={!mayEdit || !loaded || !dirty || saving}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : dirty ? `Save ${part.label.toLowerCase()}` : "Saved"}
              </button>
            </div>
            <fieldset className="visualcontrols" disabled={!mayEdit || saving || !loaded}>
              {!mayEdit ? (
                <p className="dim">
                  {part.source.kind === "settings" ? "An administrator" : "An editor"} can save these shared details.
                </p>
              ) : null}
              {!loaded && !failure ? <p role="status">Loading controls…</p> : null}
              {loaded
                ? part.source.kind === "menu"
                  ? renderMenu(values.items as MenuItem[], items => edit("items", items))
                  : loaded.fields.map(field => (
                      <div key={field.key}>
                        {renderField(field, values[field.key], value => edit(field.key, value))}
                      </div>
                    ))
                : null}
            </fieldset>
          </aside>
        </div>
      ) : failure ? (
        <div className="note err" role="alert">
          {failure}
        </div>
      ) : !website ? (
        <p role="status">Loading shared website details…</p>
      ) : null}
    </div>
  )
}
