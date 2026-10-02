import { expect, test } from "bun:test"
import { parseHTML } from "linkedom"
import { inlineHtml } from "../src/web/formatted/html.ts"

const clean = (html: string) => inlineHtml(parseHTML(`<html><body>${html}</body></html>`).document.body)

test("formatted headings preserve emphasis, breaks, and literal text", () => {
  expect(clean("Books done<br /><i>wisely.</i>")).toBe("Books done<br><i>wisely.</i>")
  expect(clean("A &amp; B &lt; C <em>today</em>")).toBe("A &amp; B &lt; C <i>today</i>")
  expect(clean("One<div>two</div><div>three</div>")).toBe("One<br>two<br>three")
  expect(clean("<i>One\ntwo</i>")).toBe("<i>One<br>two</i>")
})

test("formatted headings discard active content and attributes", () => {
  expect(clean('<i onclick="bad()" style="color:red">Hello</i><img src=x onerror=bad()><script>bad()</script>')).toBe(
    "<i>Hello</i>",
  )
  expect(clean('<svg><script>bad()</script></svg><a href="javascript:bad()">world</a>')).toBe("world")
})

test("cleared headings stay empty for required-field validation", () => {
  expect(clean("<br>")).toBe("")
  expect(clean("<div><i>&nbsp;</i><br></div>")).toBe("")
})
