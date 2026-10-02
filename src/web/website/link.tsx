import { useEffect, useState } from "react"
import { api, type MenuItem } from "../api.ts"

type Result = Awaited<ReturnType<typeof api.search>>["entries"][number]

export const MenuLink = ({ item, onChange }: { item: MenuItem; onChange: (item: MenuItem) => void }) => {
  const [choosing, setChoosing] = useState(false)
  const [query, setQuery] = useState("")
  const [matches, setMatches] = useState<Result[]>([])
  const [selected, setSelected] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    let active = true
    if (item.entryId)
      void api
        .entry(item.entryId)
        .then(entry => {
          if (active) setSelected(entry.title)
        })
        .catch(() => {
          if (active) setSelected("Page unavailable")
        })
    return () => {
      active = false
    }
  }, [item.entryId])
  useEffect(() => {
    let active = true
    setMatches([])
    setError("")
    setBusy(query.trim().length >= 2)
    if (query.trim().length < 2) return
    const timer = setTimeout(async () => {
      try {
        const [result, types] = await Promise.all([api.search(query.trim()), api.types()])
        const linked = new Set(types.filter(type => type.previewUrl).map(type => type.name))
        if (active)
          setMatches(result.entries.filter(entry => entry.status === "published" && linked.has(entry.type.name)))
      } catch {
        if (active) setError("Pages could not load. Try searching again.")
      } finally {
        if (active) setBusy(false)
      }
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [query])
  return (
    <div className="f">
      <span className="fl">Link to</span>
      {item.entryId ? (
        <span>{selected || "Loading page…"}</span>
      ) : (
        <input
          type="text"
          aria-label="Link address"
          value={item.url ?? ""}
          placeholder="Paste a web address"
          onChange={event => onChange({ ...item, entryId: undefined, url: event.target.value })}
        />
      )}
      <div className="row">
        <button type="button" className="btn sm" onClick={() => setChoosing(value => !value)}>
          {choosing ? "Close page search" : "Choose a page"}
        </button>
        {item.entryId ? (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => onChange({ ...item, entryId: undefined, url: "" })}
          >
            Use a web address
          </button>
        ) : null}
      </div>
      {choosing ? (
        <div className="menupages">
          <input
            type="search"
            aria-label="Find a page for this link"
            placeholder="Search page titles…"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
          {matches.map(entry => (
            <button
              type="button"
              className="btn"
              key={entry.id}
              onClick={() => {
                onChange({
                  ...item,
                  url: undefined,
                  entryId: entry.id,
                  label: item.label === "New link" ? entry.title : item.label,
                })
                setSelected(entry.title)
                setChoosing(false)
              }}
            >
              {entry.title}
              <small>{entry.type.label}</small>
            </button>
          ))}
          <span className="fh" role="status">
            {error ||
              (busy
                ? "Finding pages…"
                : query.trim().length < 2
                  ? "Type at least two letters. Published pages appear here."
                  : matches.length
                    ? "Choose a page above."
                    : "No published pages found. Try a different title, or paste its web address.")}
          </span>
        </div>
      ) : null}
    </div>
  )
}
