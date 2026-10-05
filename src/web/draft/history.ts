export type Draft = {
  title: string
  slug: string
  locale: string
  sortOrder: number
  data: Record<string, unknown>
}

export type History = {
  past: string[]
  present: string
  future: string[]
  saved: string
  group: string
  time: number
}

export const startHistory = (draft: Draft): History => {
  const value = JSON.stringify(draft)
  return { past: [], present: value, future: [], saved: value, group: "", time: 0 }
}

export const changeHistory = (history: History, draft: Draft, group = "", time = Date.now()): History => {
  const present = JSON.stringify(draft)
  if (present === history.present) return history
  const typing = group && group === history.group && time - history.time < 600 && !history.future.length
  return {
    ...history,
    past: typing ? history.past : [...history.past, history.present].slice(-100),
    present,
    future: [],
    group,
    time,
  }
}

export const stepHistory = (history: History, redo = false): History => {
  const source = redo ? history.future : history.past
  const present = source.at(-1)
  if (present === undefined) return history
  return {
    ...history,
    present,
    past: redo ? [...history.past, history.present] : history.past.slice(0, -1),
    future: redo ? history.future.slice(0, -1) : [...history.future, history.present],
    group: "",
    time: 0,
  }
}

// shared saves are already live; page undo must never write their old values back.
export const mergeShared = (history: History, values: Record<string, unknown>): History => {
  const merge = (snapshot: string): string => {
    const draft = JSON.parse(snapshot) as Draft
    return JSON.stringify({ ...draft, data: { ...draft.data, ...values } })
  }
  return {
    ...history,
    past: history.past.map(merge),
    present: merge(history.present),
    future: history.future.map(merge),
    saved: merge(history.saved),
  }
}

export const readRecovery = (raw: string | null): { saved: string; draft: Draft } | null => {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    const draft = value.draft
    if (
      value.version !== 1 ||
      typeof value.saved !== "string" ||
      !draft ||
      typeof draft.title !== "string" ||
      typeof draft.slug !== "string" ||
      typeof draft.locale !== "string" ||
      !Number.isFinite(draft.sortOrder) ||
      !draft.data ||
      typeof draft.data !== "object" ||
      Array.isArray(draft.data)
    )
      return null
    return { saved: value.saved, draft }
  } catch {
    return null
  }
}
