import { useEffect, useRef, useState } from "react"
import type { SharedPart } from "../../website/index.ts"
import { loadPart, type SharedContent, savePart } from "./content.ts"

export const useSharedContent = (part?: SharedPart, disabled = false) => {
  const [content, setContent] = useState<(SharedContent & { partId: string }) | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [failure, setFailure] = useState("")
  const [saved, setSaved] = useState("")
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [revision, setRevision] = useState(0)
  const lock = useRef(false)
  const loaded = content?.partId === part?.id ? content : null
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries a failed source load
  useEffect(() => {
    let active = true
    setContent(null)
    setFailure("")
    setSaved("")
    setDirty(false)
    if (part)
      void loadPart(part)
        .then(result => {
          if (!active) return
          setContent({ ...result, partId: part.id })
          setValues(result.values)
        })
        .catch(error => {
          if (active) setFailure(error.message)
        })
    return () => {
      active = false
    }
  }, [part, revision])

  const edit = (key: string, value: unknown) => {
    if (disabled || lock.current) return
    setValues(current => ({ ...current, [key]: value }))
    setDirty(true)
    setSaved("")
  }
  const save = async () => {
    if (!part || !loaded || disabled || lock.current) return false
    lock.current = true
    setSaving(true)
    setFailure("")
    try {
      await savePart(part, loaded, values)
      setContent({ ...loaded, values, menuExists: true })
      setDirty(false)
      setSaved(
        loaded.entry && loaded.entry.status !== "published"
          ? "Saved in Inkling. These details are not published yet."
          : "Saved. These details are now updated across your website.",
      )
      return true
    } catch (error) {
      setFailure((error as Error).message)
      return false
    } finally {
      lock.current = false
      setSaving(false)
    }
  }
  return { loaded, values, failure, saved, dirty, saving, edit, save, reload: () => setRevision(value => value + 1) }
}

export type SharedState = ReturnType<typeof useSharedContent>
