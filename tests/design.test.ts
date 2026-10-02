import { expect, test } from "bun:test"
import { connect } from "atlas/db"
import { router } from "atlas/server"
import type { Proposal } from "../src/ai/tools/index.ts"
import { runTool, specsFor, toolsFor } from "../src/ai/tools/index.ts"
import { issueSession } from "../src/auth/index.ts"
import {
  cleanValue,
  designCss,
  designPublicRoutes,
  designRoutes,
  merge,
  readRules,
  type Surfaces,
} from "../src/design/index.ts"
import { up } from "../src/migrate/index.ts"
import { createHooks } from "../src/plugins/hooks.ts"
import { createRegistry } from "../src/plugins/index.ts"
import { createUser } from "../src/users/index.ts"

const surfaces: Surfaces = {
  buttons: { label: "Buttons", selector: ".button, .cta", describes: "Every call-to-action button" },
  headings: { label: "Headings", selector: "h1, h2" },
}

const setup = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const session = async (role: "owner" | "editor") => {
    const user = await createUser(db, {
      email: `${role}@example.com`,
      name: role,
      password: "a secure password",
      role,
    })
    return (await issueSession(db, user, { ip: "127.0.0.1", userAgent: "tests" })).token
  }
  const handle = router(...designRoutes(db, surfaces), ...designPublicRoutes(db, surfaces))
  const call = (token: string | null, method: string, path: string, body?: unknown) =>
    handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
  return { db, session, call }
}

test("values are checked against their property's type, not a blocklist", () => {
  expect(cleanValue("background", "#000")).toBe("#000")
  expect(cleanValue("background", "black")).toBe("black")
  expect(cleanValue("background", "oklch(20% 0.02 260)")).toBe("oklch(20% 0.02 260)")
  expect(cleanValue("border-radius", "0")).toBe("0")
  expect(cleanValue("padding", "12px 24px")).toBe("12px 24px")
  expect(cleanValue("opacity", "0.5")).toBe("0.5")
  expect(cleanValue("font-weight", "700")).toBe("700")
  expect(cleanValue("text-transform", "UPPERCASE")).toBe("uppercase")

  // Each of these would load a resource, close the declaration, or smuggle in a
  // second one — and a colour or a length simply cannot be any of them.
  for (const evil of [
    "url(https://evil.test/x.png)",
    "red; } body { display: none",
    "red} @import 'x'",
    "expression(alert(1))",
    "red /* x */",
    "#000 !important; position: fixed",
    "",
  ]) {
    expect(cleanValue("background", evil)).toBeNull()
  }
  expect(cleanValue("border-radius", "12")).toBeNull() // a bare number is not a length
  expect(cleanValue("opacity", "2")).toBeNull()
  expect(cleanValue("box-shadow", "0 0 0 url(x)")).toBeNull()
  expect(cleanValue("position", "fixed")).toBeNull() // not a property that exists here
  expect(cleanValue("background", 5)).toBeNull()
})

test("the stylesheet is built from the host's selectors and nothing the model supplied", () => {
  const rules = merge(
    surfaces,
    [],
    [
      { surface: "buttons", property: "background", value: "#000" },
      { surface: "buttons", property: "color", value: "#fff" },
      { surface: "gone", property: "color", value: "red" }, // a surface the host never declared
    ],
  )
  expect(rules).toHaveLength(2)
  const css = designCss(surfaces, rules)
  expect(css).toContain(".button, .cta {")
  expect(css).toContain("background: #000 !important;")
  expect(css).not.toContain("gone")
  expect(designCss(surfaces, [])).toBe("")

  // A null clears the override, which is how "put it back" is said.
  const cleared = merge(surfaces, rules, [{ surface: "buttons", property: "background", value: null }])
  expect(cleared.map(rule => rule.property)).toEqual(["color"])
})

test("applying a design change needs the settings capability, and rejects anything off the list", async () => {
  const { session, call } = await setup()
  const owner = await session("owner")
  const editor = await session("editor")
  const change = { surface: "buttons", property: "background", value: "#000" }

  expect((await call(null, "PUT", "/design", { changes: [change] })).status).toBe(401)
  expect((await call(editor, "PUT", "/design", { changes: [change] })).status).toBe(403)

  expect((await call(owner, "PUT", "/design", { changes: [] })).status).toBe(400)
  expect((await call(owner, "PUT", "/design", { changes: [{ ...change, surface: "nope" }] })).status).toBe(400)
  expect((await call(owner, "PUT", "/design", { changes: [{ ...change, property: "position" }] })).status).toBe(400)
  expect((await call(owner, "PUT", "/design", { changes: [{ ...change, value: "url(//x.test/a)" }] })).status).toBe(400)

  const saved = await call(owner, "PUT", "/design", { changes: [change] })
  expect(saved.status).toBe(200)
  expect(((await saved.json()) as { rules: unknown[] }).rules).toEqual([change])
})

test("the public stylesheet is served without a key, versioned, and revalidates", async () => {
  const { db, session, call } = await setup()
  const owner = await session("owner")

  const empty = await call(null, "GET", "/site/design.css")
  expect(empty.status).toBe(200)
  expect(empty.headers.get("content-type")).toContain("text/css")
  expect(await empty.text()).toBe("")

  await call(owner, "PUT", "/design", { changes: [{ surface: "headings", property: "color", value: "#00aeef" }] })
  const live = await call(null, "GET", "/site/design.css")
  const css = await live.text()
  expect(css).toContain("h1, h2 {")
  expect(css).toContain("color: #00aeef !important;")

  const tag = live.headers.get("etag") ?? ""
  expect(tag).not.toBe("")

  // Unchanged design: the browser's validator gets a 304 and no body.
  const handle = router(...designPublicRoutes(db, surfaces))
  const revalidated = await handle(
    new Request("http://localhost/site/design.css", { headers: { "if-none-match": tag } }),
  )
  expect(revalidated.status).toBe(304)

  // A changed design is a new version.
  await call(owner, "PUT", "/design", { changes: [{ surface: "headings", property: "color", value: "#000" }] })
  expect((await call(null, "GET", "/site/design.css")).headers.get("etag")).not.toBe(tag)
})

test("Inky only gets the design tools when the host exposed something to restyle", () => {
  const names = (design: Surfaces) => toolsFor("owner", design).map(tool => tool.name)
  expect(names({})).not.toContain("propose_design_change")
  expect(names({})).not.toContain("get_design")
  expect(names(surfaces)).toEqual(expect.arrayContaining(["get_design", "propose_design_change"]))
  expect(specsFor("owner", {}).some(spec => spec.name === "get_design")).toBe(false)

  // An editor could not apply a design change, so is never offered one.
  expect(toolsFor("editor", surfaces).map(tool => tool.name)).not.toContain("propose_design_change")
})

test("a design proposal is validated while Inky can still correct it, and queued only when real", async () => {
  const { db } = await setup()
  const registry = await createRegistry(db, createHooks(), "./plugins", "")
  const proposals: Proposal[] = []
  const run = (input: object) =>
    runTool(
      { db, registry, design: surfaces, role: "owner", proposals },
      "propose_design_change",
      input as Record<string, unknown>,
    )

  const bad = await run({
    summary: "x",
    changes: [{ surface: "buttons", property: "background", value: "url(//x.test)" }],
  })
  expect(bad.isError).toBe(true)
  const unknown = await run({ summary: "x", changes: [{ surface: "footer", property: "color", value: "red" }] })
  expect((unknown.output as { error: string }).error).toContain("buttons, headings")
  expect(proposals).toHaveLength(0)

  const ok = await run({
    summary: "Black buttons",
    changes: [
      { surface: "buttons", property: "background", value: "#000" },
      { surface: "buttons", property: "color", value: "#fff" },
    ],
  })
  expect(ok.isError).toBeFalsy()
  expect(proposals).toHaveLength(1)
  const queued = proposals[0] as Extract<Proposal, { kind: "design.update" }>
  expect(queued.kind).toBe("design.update")
  expect(queued.needs).toBe("settings.manage")
  expect(queued.before).toEqual({ "buttons.background": null, "buttons.color": null })

  // Nothing is written until the person applies it.
  expect(await readRules(db, surfaces)).toEqual([])
})
