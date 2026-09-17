import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { HELP } from "../src/web/help.ts"
import { HelpContent, HelpScreen } from "../src/web/helpview.tsx"

test("Help lists every registered topic once, with setup collapsed", () => {
  const html = renderToStaticMarkup(createElement(HelpScreen))
  expect(html.match(/class="helptopic"/g)?.length).toBe(Object.keys(HELP).length)
  expect(html.match(/class="helpgroup" open=""/g)?.length).toBe(1)
  expect(html).toContain('type="search"')
  for (const entry of Object.values(HELP)) {
    expect(html).toContain(renderToStaticMarkup(createElement("summary", null, entry.title)))
  }
})

test("Help pages and inline hints share steps, examples, and consequences", () => {
  const html = renderToStaticMarkup(createElement(HelpContent, { entry: HELP["entry.save"] }))
  expect(html).toContain("What to do")
  expect(html).toContain("Save draft")
  expect(html).toContain("Save live changes")
  expect(html).toContain("For example:")
  expect(html).toContain("Worth knowing:")
})
