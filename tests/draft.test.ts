import { expect, test } from "bun:test"
import {
  changeHistory,
  type Draft,
  mergeShared,
  readRecovery,
  startHistory,
  stepHistory,
} from "../src/web/draft/history.ts"
import { reorderSections } from "../src/web/visual/order.ts"

const original: Draft = {
  title: "Home",
  slug: "home",
  locale: "en",
  sortOrder: 0,
  data: { heading: "Hello", logo: "old.svg", __layout: { order: ["intro", "books"], hidden: [] } },
}
const heading = (value: string): Draft => ({ ...original, data: { ...original.data, heading: value } })

test("typing is grouped, field changes are separate, and undo returns to the saved baseline", () => {
  let history = startHistory(original)
  history = changeHistory(history, heading("H"), "heading", 1000)
  history = changeHistory(history, heading("Hi"), "heading", 1200)
  expect(history.past).toHaveLength(1)
  history = changeHistory(history, { ...heading("Hi"), title: "Welcome" }, "title", 1250)
  expect(history.past).toHaveLength(2)
  history = stepHistory(history)
  expect(JSON.parse(history.present).title).toBe("Home")
  expect(JSON.parse(history.present).data.heading).toBe("Hi")
  history = stepHistory(history)
  expect(history.present).toBe(history.saved)
  expect(stepHistory(history)).toBe(history)
  expect(JSON.parse(stepHistory(history, true).present).data.heading).toBe("Hi")
})

test("layout changes undo individually, and editing after undo removes the redo branch", () => {
  let history = startHistory(original)
  history = changeHistory(history, {
    ...original,
    data: { ...original.data, __layout: { order: ["books", "intro"], hidden: [] } },
  })
  history = changeHistory(history, {
    ...original,
    data: { ...original.data, __layout: { order: ["books", "intro"], hidden: ["books"] } },
  })
  history = stepHistory(history)
  expect(JSON.parse(history.present).data.__layout).toEqual({ order: ["books", "intro"], hidden: [] })
  history = changeHistory(history, heading("New direction"))
  expect(history.future).toEqual([])
  expect(stepHistory(history, true)).toBe(history)
})

test("shared saves survive undo and redo without marking an unchanged page dirty", () => {
  let history = changeHistory(startHistory(original), heading("Welcome"))
  history = mergeShared(history, { logo: "new.svg" })
  const undone = stepHistory(history)
  expect(JSON.parse(undone.present).data.logo).toBe("new.svg")
  expect(undone.present).toBe(undone.saved)
  expect(JSON.parse(stepHistory(undone, true).present).data.logo).toBe("new.svg")
})

test("history keeps immutable snapshots and bounds memory for long editing sessions", () => {
  let history = startHistory(original)
  for (let i = 0; i < 150; i++) history = changeHistory(history, heading(String(i)))
  expect(history.past).toHaveLength(100)
  expect(history.saved).toBe(JSON.stringify(original))
  expect(changeHistory(history, heading("149"))).toBe(history)
})

test("recovery accepts complete drafts and rejects corrupt browser storage", () => {
  const saved = JSON.stringify(original)
  expect(readRecovery(JSON.stringify({ version: 1, saved, draft: heading("Recovered") }))).toEqual({
    saved,
    draft: heading("Recovered"),
  })
  for (const raw of [
    null,
    "",
    "broken",
    "null",
    "{}",
    JSON.stringify({ version: 2, saved, draft: original }),
    JSON.stringify({ version: 1, saved, draft: { ...original, data: [] } }),
    JSON.stringify({ version: 1, saved, draft: { ...original, sortOrder: "1" } }),
  ])
    expect(readRecovery(raw)).toBeNull()
})

test("section dragging moves in either direction and cannot move or cross a fixed section", () => {
  const sections = [{ id: "hero" }, { id: "intro" }, { id: "books" }, { id: "form", movable: false }, { id: "closing" }]
  expect(reorderSections(sections, "hero", "books")).toEqual(["intro", "books", "hero", "form", "closing"])
  expect(reorderSections(sections, "books", "hero")).toEqual(["books", "hero", "intro", "form", "closing"])
  for (const [from, to] of [
    ["hero", "closing"],
    ["form", "hero"],
    ["hero", "form"],
    ["absent", "hero"],
    ["hero", "hero"],
  ])
    expect(reorderSections(sections, from ?? "", to ?? "")).toBeNull()
  expect(sections.map(section => section.id)).toEqual(["hero", "intro", "books", "form", "closing"])
})
