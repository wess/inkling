import { expect, test } from "bun:test"
import { connect } from "atlas/db"
import { router } from "atlas/server"
import { parseHTML } from "linkedom"
import { issueSession } from "../src/auth/index.ts"
import { up } from "../src/migrate/index.ts"
import { createUser } from "../src/users/index.ts"
import { renderVisual, type VisualPage, visualRoutes } from "../src/visual/index.ts"
import { readLayout } from "../src/visual/layout.ts"

const definition: VisualPage = {
  sections: [
    { id: "intro", label: "Opening", selector: "main > .intro", fields: ["heading"] },
    { id: "form", label: "Contact", selector: "main > form", fields: [], movable: false },
    { id: "books", label: "Books", selector: "main > .books", fields: [] },
    { id: "quotes", label: "Kind words", selector: "main > .quotes", fields: [] },
  ],
  fields: { heading: ".intro h1", image: ".intro img", $title: "title" },
}
const html =
  '<!doctype html><html><head><title>A page</title></head><body><header>Site header</header><main><section class="intro"><h1>Hello</h1><img src="/cover.jpg"></section><form>Contact</form><section class="books">Books</section><aside>Keep here</aside><section class="quotes">Kind words</section></main><footer>Footer</footer></body></html>'

test("published layouts reorder declared siblings, preserve fixed elements, and hide sections", () => {
  const output = renderVisual(html, definition, {
    order: ["quotes", "form", "books", "intro", "unknown"],
    hidden: ["books", "unknown"],
  })
  const { document } = parseHTML(output)
  expect(
    Array.from(document.querySelector("main")?.children ?? []).map(
      element => element.className || element.tagName.toLowerCase(),
    ),
  ).toEqual(["quotes", "form", "aside", "intro"])
  expect(document.querySelector("header")?.textContent).toBe("Site header")
  expect(document.querySelector("footer")?.textContent).toBe("Footer")
  expect(document.querySelector(".books")).toBeNull()
  expect(document.querySelector("[data-inkling-section]")).toBeNull()
  expect(output).toStartWith("<!DOCTYPE html>")
})

test("editing annotates real text and images, retaining hidden sections for selection", () => {
  const { document } = parseHTML(renderVisual(html, definition, { hidden: ["books"] }, true))
  expect(document.querySelector(".intro")?.getAttribute("data-inkling-label")).toBe("Opening")
  expect(document.querySelector("h1")?.getAttribute("data-inkling-field")).toBe("heading")
  expect(document.querySelector("img")?.getAttribute("data-inkling-field")).toBe("image")
  expect(document.querySelector("title")?.getAttribute("data-inkling-field")).toBe("$title")
  expect(document.querySelector(".books")?.getAttribute("data-inkling-hidden")).toBe("true")
})

test("layouts leave undeclared and nested structure intact", () => {
  const nested =
    '<html><body><main><section class="outer"><section class="inner">Nested</section></section><section class="last">Last</section></main></body></html>'
  const page: VisualPage = {
    sections: [
      { id: "last", label: "Last", selector: ".last", fields: [] },
      { id: "inner", label: "Inner", selector: ".inner", fields: [] },
      { id: "outer", label: "Outer", selector: ".outer", fields: [] },
    ],
  }
  const { document } = parseHTML(renderVisual(nested, page, undefined))
  expect(document.querySelector("main")?.firstElementChild?.className).toBe("outer")
  const moved = parseHTML(renderVisual(nested, page, { order: ["last", "inner", "outer"] })).document
  expect(moved.querySelector("main")?.firstElementChild?.className).toBe("last")
  expect(moved.querySelector(".inner")?.parentElement?.className).toBe("outer")
})

test("layout validation accepts section names, rejecting executable data and unbounded lists", () => {
  expect(readLayout({ order: ["hero", "aboutUs"], hidden: [] })).toEqual({ order: ["hero", "aboutUs"], hidden: [] })
  for (const value of [
    [],
    "hero",
    { style: "display:none" },
    { hidden: ["body > *"] },
    { order: ["hero", "hero"] },
    { order: Array.from({ length: 101 }, (_, index) => `section${index}`) },
  ]) {
    expect(() => readLayout(value)).toThrow()
  }
})

test("visual page definitions require an authenticated content reader", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const user = await createUser(db, {
    email: "visual@example.com",
    name: "Editor",
    password: "a secure password",
    role: "editor",
  })
  const session = await issueSession(db, user, { ip: "127.0.0.1", userAgent: "tests" })
  const handle = router(...visualRoutes(db, { homepage: definition }))
  expect((await handle(new Request("http://localhost/visual"))).status).toBe(401)
  const response = await handle(
    new Request("http://localhost/visual", { headers: { authorization: `Bearer ${session.token}` } }),
  )
  expect(await response.json()).toEqual({ data: { homepage: definition } })
  await db.close()
})
