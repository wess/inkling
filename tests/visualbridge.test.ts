import { expect, test } from "bun:test"
import { DOMParser, parseHTML } from "linkedom"
import { BRIDGE, BRIDGE_HASH } from "../src/web/visual/bridge.ts"
import { prepare } from "../src/web/visual/prepare.ts"
import { readRect, readSelection, selectionKey } from "../src/web/visual/protocol.ts"

test("the only preview script matches the policy hash and parses independently", () => {
  expect(new Bun.CryptoHasher("sha256").update(BRIDGE).digest("base64")).toBe(BRIDGE_HASH)
  expect(() => new Function(BRIDGE)).not.toThrow()
})

test("preview preparation removes host execution and pins the owned bridge before host content", () => {
  const previous = globalThis.DOMParser
  globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser
  try {
    const html = prepare(
      `<html><head><base href="https://elsewhere.example"><meta http-equiv="refresh" content="0;url=/leave"><script>parent.stolen = true</script></head><body onload="bad()"><section class="notice"><img class="badge" src="/badge.svg" onerror="bad()" autofocus></section><iframe src="/nested"></iframe><object data="/object"></object><a href="javascript:bad()">Link</a></body></html>`,
      "https://site.example/page",
      [
        {
          id: "notice",
          label: "Announcement",
          description: "Shared notice",
          selector: ".notice",
          source: { kind: "settings", fields: ["notice"] },
        },
        {
          id: "badge",
          label: "Membership badge",
          description: "Shared badge",
          selector: ".badge",
          source: { kind: "settings", fields: ["badge"] },
        },
      ],
      'channel</script><script>bad()</script>"',
      "https://site.example",
    )
    const { document } = parseHTML(html)
    expect(document.querySelectorAll("script")).toHaveLength(1)
    expect(document.querySelector("script")?.textContent).toBe(BRIDGE)
    expect(document.querySelector("iframe, object, embed, base, [onload], [onerror], [autofocus]")).toBeNull()
    expect(document.querySelector("a")?.hasAttribute("href")).toBe(false)
    expect(document.querySelector("img")?.getAttribute("src")).toBe("https://site.example/badge.svg")
    expect(document.querySelector("img")?.getAttribute("data-inkling-shared")).toBe("badge")
    const policy = document.head.firstElementChild
    expect(policy?.getAttribute("http-equiv")).toBe("Content-Security-Policy")
    expect(policy?.getAttribute("content")).toContain(`script-src 'sha256-${BRIDGE_HASH}'`)
    expect(policy?.getAttribute("content")).toContain("connect-src 'none'")
    expect(policy?.getAttribute("content")).toContain("form-action 'none'")
    expect(JSON.parse(document.querySelector('meta[name="inkling-preview"]')?.getAttribute("content") ?? "{}")).toEqual(
      {
        channel: 'channel</script><script>bad()</script>"',
        origin: "https://site.example",
      },
    )
  } finally {
    globalThis.DOMParser = previous
  }
})

test("preview messages can select only known controls and carry bounded geometry", () => {
  const labels = { heading: "Heading", hero: "Hero" }
  expect(readSelection({ shared: "badge", field: "heading" }, ["badge"], labels)).toEqual({ shared: "badge" })
  expect(readSelection({ shared: "unknown", field: "heading" }, ["badge"], labels)).toBeNull()
  expect(readSelection({ field: "constructor" }, [], labels)).toBeNull()
  expect(readSelection(null, [], labels)).toBeNull()
  expect(readSelection({ field: "heading", section: "hero" }, [], labels)).toEqual({
    field: "heading",
    section: "hero",
  })
  expect(selectionKey({ field: "heading" })).toBe(selectionKey({ field: "heading", section: undefined }))
  expect(readRect({ x: -20, y: 0, width: 200, height: 50 })).toEqual({ x: -20, y: 0, width: 200, height: 50 })
  for (const width of [-1, Infinity, NaN, 1e8, "20"]) {
    expect(readRect({ x: 0, y: 0, width, height: 50 })).toBeNull()
  }
})
