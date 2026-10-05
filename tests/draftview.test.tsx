import { afterEach, beforeEach, expect, test } from "bun:test"
import { parseHTML } from "linkedom"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { Draft } from "../src/web/draft/history.ts"
import { useDraft } from "../src/web/draft/index.ts"
import { Sections } from "../src/web/visual/sections.tsx"

const saved = new Map<string, string>()
const previous = new Map<string, PropertyDescriptor | undefined>()
let root: Root
let document: Document
let draft: ReturnType<typeof useDraft>
const original: Draft = { title: "Home", slug: "home", locale: "en", sortOrder: 0, data: { heading: "Hello" } }

beforeEach(() => {
  const dom = parseHTML("<html><body><div id='root'></div></body></html>")
  const globals = {
    document: dom.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    sessionStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value)
      },
      removeItem: (key: string) => {
        saved.delete(key)
      },
    },
  }
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  document = dom.document as unknown as Document
  root = createRoot(document.getElementById("root") as HTMLElement)
})

afterEach(async () => {
  await act(async () => root.unmount())
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  previous.clear()
  saved.clear()
})

const Harness = ({ owner = "editor:home" }: { owner?: string }) => {
  draft = useDraft(owner)
  return null
}

test("a reload offers the stored draft, restoration stays dirty, and saving clears recovery", async () => {
  await act(async () => root.render(<Harness />))
  await act(async () => draft.reset(original))
  await act(async () => draft.set("data", { heading: "Unsaved" }))
  expect(saved.size).toBe(1)
  await act(async () => root.render(null))
  await act(async () => root.render(<Harness />))
  await act(async () => draft.reset(original))
  expect(draft.value.data.heading).toBe("Hello")
  expect(draft.recovery?.draft.data.heading).toBe("Unsaved")
  await act(async () => draft.restore())
  expect(draft.dirty).toBe(true)
  expect(draft.value.data.heading).toBe("Unsaved")
  await act(async () => draft.markSaved(draft.value))
  expect(draft.dirty).toBe(false)
  expect(saved.size).toBe(0)
  await act(async () => draft.undo())
  expect(draft.dirty).toBe(true)
  expect(saved.size).toBe(1)
})

test("recovery detects changed server content and stays scoped to the signed-in editor", async () => {
  await act(async () => root.render(<Harness />))
  await act(async () => draft.reset(original))
  await act(async () => draft.set("data", { heading: "Unsaved" }))
  await act(async () => draft.reset({ ...original, data: { heading: "Another editor's change" } }))
  expect(draft.recoveryConflict).toBe(true)
  expect(draft.value.data.heading).toBe("Another editor's change")
  await act(async () => root.render(<Harness owner="someoneelse:home" />))
  await act(async () => draft.reset(original))
  expect(draft.recovery).toBeNull()
})

test("discarding a recovery keeps server values and clears the stored draft", async () => {
  await act(async () => root.render(<Harness />))
  await act(async () => draft.reset(original))
  await act(async () => draft.set("title", "Changed"))
  await act(async () => draft.reset(original))
  await act(async () => draft.discardRecovery())
  expect(draft.value.title).toBe("Home")
  expect(draft.dirty).toBe(false)
  expect(saved.size).toBe(0)
})

test("a section drag commits only on drop and a cancelled drag does not poison the next one", async () => {
  const moves: string[][] = []
  await act(async () =>
    root.render(
      <Sections
        sections={[
          { id: "hero", label: "Welcome", selector: ".hero", fields: [] },
          { id: "books", label: "Books", selector: ".books", fields: [] },
        ]}
        hidden={[]}
        disabled={false}
        select={() => {}}
        toggle={() => {}}
        reorder={order => moves.push(order)}
      />,
    ),
  )
  const handle = document.querySelector(".visualgrip") as HTMLElement
  const row = document.querySelectorAll("li")[1] as HTMLElement
  const transfer = { effectAllowed: "", dropEffect: "", setData: () => {} }
  const drag = async (node: HTMLElement, type: string) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true })
    Object.assign(event, { dataTransfer: transfer })
    await act(async () => {
      node.dispatchEvent(event)
    })
  }
  await drag(handle, "dragstart")
  await drag(row, "dragover")
  expect(moves).toEqual([])
  await drag(handle, "dragend")
  await drag(row, "drop")
  expect(moves).toEqual([])
  await drag(handle, "dragstart")
  await drag(row, "dragover")
  await drag(row, "drop")
  expect(moves).toEqual([["books", "hero"]])
})
