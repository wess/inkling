import { expect, test } from "bun:test"
import { parseHTML } from "linkedom"
import { selectedElement, selectionAt } from "../src/web/visual/selection.ts"

test("a badge inside a shared announcement selects its own image controls", () => {
  const { document } = parseHTML(
    '<div data-inkling-shared="announcement"><img data-inkling-shared="badge" alt="Membership badge"></div>',
  )
  const selection = selectionAt(document.querySelector("img") as never)
  expect(selection?.shared).toBe("badge")
  expect(selectedElement(document as never, selection ?? {})).toBe(document.querySelector("img") as never)
})

test("formatted text retains both its field and section identity", () => {
  const { document } = parseHTML(
    '<section data-inkling-section="hero"><h1 data-inkling-field="heading"><em>Stories</em></h1></section><footer>Elsewhere</footer>',
  )
  expect(selectionAt(document.querySelector("em") as never)).toEqual({
    field: "heading",
    section: "hero",
    shared: undefined,
  })
  expect(selectionAt(document.querySelector("footer") as never)).toBeNull()
})
