import { type ReactNode, useEffect, useRef } from "react"
import type { SharedPart } from "../../website/index.ts"
import type { Field, MenuItem } from "../api.ts"
import type { SharedState } from "./state.ts"

export type SharedInputs = {
  renderField: (field: Field, value: unknown, change: (value: unknown) => void) => ReactNode
  renderMenu: (items: MenuItem[], change: (items: MenuItem[]) => void) => ReactNode
}

export const SharedInspector = ({
  part,
  state,
  role,
  disabled = false,
  save,
  switching,
  before,
  renderField,
  renderMenu,
}: SharedInputs & {
  part: SharedPart
  state: SharedState
  role: string
  disabled?: boolean
  save: () => Promise<boolean>
  switching?: { label: string; accept: () => void; cancel: () => void } | null
  before?: ReactNode
}) => {
  const actions = useRef<HTMLDivElement>(null)
  const { loaded, values, failure, saved, dirty, saving, edit } = state
  const mayEdit =
    part.source.kind === "settings" ? ["owner", "admin"].includes(role) : ["owner", "admin", "editor"].includes(role)
  useEffect(() => {
    const bar = actions.current
    if (!bar) return
    const measure = () =>
      bar
        .closest<HTMLElement>(".sharedscreen, .visualeditor")
        ?.style.setProperty("--sharedactions", `${bar.offsetHeight + 24}px`)
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [])
  const destination = switching?.label
  useEffect(() => {
    if (destination) actions.current?.querySelector<HTMLElement>(".sharedswitch")?.focus()
  }, [destination])
  return (
    <aside className="visualinspector sharedinspector" aria-label="Shared website editing controls">
      {before}
      <div className="sharedintro">
        <h2>{part.label}</h2>
        <p>{part.description}</p>
        <p className="dim">Changes apply everywhere this part appears.</p>
      </div>
      <div className="visualactions" ref={actions}>
        {failure ? (
          <div className="note err" role="alert">
            {failure}
            {!loaded ? (
              <button type="button" className="btn" onClick={state.reload}>
                Reload controls
              </button>
            ) : null}
          </div>
        ) : null}
        {switching ? (
          <section className="sharedswitch" aria-label="Unsaved changes before switching" tabIndex={-1}>
            <p>
              Save your changes to {part.label.toLowerCase()} before opening {switching.label}?
            </p>
            <button
              type="button"
              className="btn primary"
              disabled={disabled || saving}
              onClick={async () => {
                if (await save()) switching.accept()
              }}
            >
              Save and switch
            </button>
            <button type="button" className="btn" disabled={disabled || saving} onClick={switching.cancel}>
              Keep editing
            </button>
            <button type="button" className="btn ghost" disabled={disabled || saving} onClick={switching.accept}>
              Discard and switch
            </button>
          </section>
        ) : (
          <>
            <p role="status">{saved || (dirty ? "Unsaved changes" : "No unsaved changes")}</p>
            <button
              type="button"
              className="btn primary"
              disabled={disabled || !mayEdit || !loaded || !dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : dirty ? `Save ${part.label.toLowerCase()}` : "Saved"}
            </button>
          </>
        )}
      </div>
      <fieldset className="visualcontrols" disabled={disabled || !mayEdit || saving || !loaded}>
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
                <div key={field.key}>{renderField(field, values[field.key], value => edit(field.key, value))}</div>
              ))
          : null}
      </fieldset>
    </aside>
  )
}
