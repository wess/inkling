import { useCallback, useRef, useState } from "react"
import { changeHistory, type Draft, mergeShared, readRecovery, startHistory, stepHistory } from "./history.ts"

const empty: Draft = { title: "", slug: "", locale: "en", sortOrder: 0, data: {} }

export const useDraft = (key: string) => {
  const [history, setHistory] = useState(() => startHistory(empty))
  const current = useRef(history)
  const [recovery, setRecovery] = useState<ReturnType<typeof readRecovery>>(null)
  const [storageFailure, setStorageFailure] = useState(false)
  const storageKey = `inkling:draft:${key}`
  const persist = (next: typeof history) => {
    try {
      if (next.present === next.saved) sessionStorage.removeItem(storageKey)
      else
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            version: 1,
            saved: next.saved,
            draft: JSON.parse(next.present),
          }),
        )
      setStorageFailure(false)
    } catch {
      setStorageFailure(true)
    }
  }
  const apply = (next: typeof history) => {
    current.current = next
    setHistory(next)
    persist(next)
  }
  const reset = useCallback(
    (draft: Draft) => {
      const next = startHistory(draft)
      current.current = next
      setHistory(next)
      try {
        const recovered = readRecovery(sessionStorage.getItem(storageKey))
        setRecovery(recovered && JSON.stringify(recovered.draft) !== next.saved ? recovered : null)
      } catch {
        setStorageFailure(true)
      }
    },
    [storageKey],
  )
  const set = <K extends keyof Draft>(
    key: K,
    value: Draft[K] | ((value: Draft[K]) => Draft[K]),
    group: string = key,
  ) => {
    const draft = JSON.parse(current.current.present) as Draft
    const next = typeof value === "function" ? value(draft[key]) : value
    apply(changeHistory(current.current, { ...draft, [key]: next }, group))
  }
  const markSaved = (draft: Draft) => {
    const saved = JSON.stringify(draft)
    apply({ ...current.current, present: saved, saved, group: "", time: 0 })
    setRecovery(null)
  }
  const restore = () => {
    if (!recovery) return
    apply(changeHistory(current.current, recovery.draft))
    setRecovery(null)
  }
  const discardRecovery = () => {
    setRecovery(null)
    persist(current.current)
  }
  return {
    value: JSON.parse(history.present) as Draft,
    dirty: history.present !== history.saved,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    recovery,
    recoveryConflict: recovery && recovery.saved !== history.saved,
    storageFailure,
    set,
    reset,
    markSaved,
    restore,
    discardRecovery,
    undo: () => apply(stepHistory(current.current)),
    redo: () => apply(stepHistory(current.current, true)),
    sharedSaved: (values: Record<string, unknown>) => apply(mergeShared(current.current, values)),
    clear: () => markSaved(JSON.parse(current.current.present) as Draft),
  }
}
