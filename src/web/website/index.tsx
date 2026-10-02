import { Monitor, Smartphone } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import type { Website } from "../../website/index.ts"
import { api, type Field, type MenuItem } from "../api.ts"
import { askTarget, selectTarget } from "../inkystore.ts"
import { Canvas } from "../visual/canvas.tsx"
import { focusControl } from "../visual/selection.ts"
import { SharedInspector } from "./inspector.tsx"
import { useSharedContent } from "./state.ts"
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
  const [failure, setFailure] = useState("")
  const [previewFailure, setPreviewFailure] = useState("")
  const [preview, setPreview] = useState<{ html: string; url: string } | null>(null)
  const [revision, setRevision] = useState(0)
  const [phone, setPhone] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const focusPart = useRef<string | null>(null)
  const part = website?.parts.find(item => item.id === partId) ?? website?.parts[0]
  const state = useSharedContent(part)
  const { loaded, dirty, saving } = state
  useEffect(() => {
    selectTarget(part ? { label: part.label, shared: part.id } : null)
    return () => selectTarget(null)
  }, [part])
  useEffect(() => {
    if (loaded && focusPart.current === part?.id) {
      const frame = requestAnimationFrame(() => {
        focusPart.current = null
        focusControl(document.querySelector(".sharedscreen .visualcontrols"))
      })
      return () => cancelAnimationFrame(frame)
    }
  }, [loaded, part?.id])
  const openPart = (id: string) => {
    setSwitching(null)
    delete document.body.dataset.unsaved
    onSelect(id)
  }
  const choosePart = (id: string, focus = false) => {
    if (saving) return
    if (id === part?.id) {
      if (focus) {
        if (loaded) requestAnimationFrame(() => focusControl(document.querySelector(".sharedscreen .visualcontrols")))
        else focusPart.current = id
      }
      return
    }
    focusPart.current = focus ? id : null
    if (dirty) setSwitching(id)
    else openPart(id)
  }

  useEffect(() => {
    void api
      .website()
      .then(setWebsite)
      .catch(error => setFailure(error.message))
  }, [])
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

  const save = async () => {
    if (!(await state.save())) return false
    setRevision(value => value + 1)
    return true
  }

  return (
    <div className="sharedscreen">
      <header>
        <h1>Header, footer & shared details</h1>
        <p className="dim">
          Choose a part below, or double-click it in the preview. Right-click for editing actions and Ask Inky.
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
            onClick={() => choosePart(item.id)}
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
                    if (selection.shared) choosePart(selection.shared)
                  }}
                  onEdit={selection => {
                    if (selection.shared) choosePart(selection.shared, true)
                  }}
                  onAsk={(selection, anchor, restore) => {
                    const selected = website?.parts.find(part => part.id === selection.shared)
                    if (selected) askTarget({ label: selected.label, shared: selected.id }, anchor, restore)
                  }}
                  phone={phone}
                  labels={{}}
                />
              ) : (
                <div className="visualempty">{previewFailure || "Loading your website…"}</div>
              )}
            </div>
          </div>
          <SharedInspector
            part={part}
            state={state}
            role={role}
            save={save}
            renderField={renderField}
            renderMenu={renderMenu}
            switching={
              switching
                ? {
                    label: website?.parts.find(item => item.id === switching)?.label.toLowerCase() ?? "another part",
                    accept: () => openPart(switching),
                    cancel: () => {
                      setSwitching(null)
                      focusPart.current = null
                    },
                  }
                : null
            }
          />
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
