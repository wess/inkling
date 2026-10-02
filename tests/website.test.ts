import { afterEach, expect, spyOn, test } from "bun:test"
import { connect } from "atlas/db"
import { router } from "atlas/server"
import { issueSession } from "../src/auth/index.ts"
import { up } from "../src/migrate/index.ts"
import { createUser } from "../src/users/index.ts"
import { api } from "../src/web/api.ts"
import { loadPart, savePart } from "../src/web/website/content.ts"
import { type SharedPart, websiteRoutes } from "../src/website/index.ts"

const footer: SharedPart = {
  id: "footer",
  label: "Footer",
  description: "Shared small print",
  selector: "footer",
  source: { kind: "entry", type: "house", fields: ["colophon"] },
}
const mocks: { mockRestore: () => void }[] = []
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore()
})

test("the shared website map is available to signed-in readers, never anonymous visitors", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const user = await createUser(db, {
    name: "Reader",
    email: "shared@example.com",
    password: "a secure password",
    role: "viewer",
  })
  const session = await issueSession(db, user, { ip: "127.0.0.1", userAgent: "tests" })
  const website = { previewUrl: "/", parts: [footer] }
  const handle = router(...websiteRoutes(db, website))
  expect((await handle(new Request("http://test/website"))).status).toBe(401)
  const response = await handle(
    new Request("http://test/website", { headers: { authorization: `Bearer ${session.token}` } }),
  )
  expect(await response.json()).toEqual(website)
  await db.close()
})

test("a shared edit only sends changed fields belonging to that part", async () => {
  const save = spyOn(api, "updateEntry").mockResolvedValue({} as never)
  mocks.push(save)
  const values = { colophon: "Original", phone: "123", notice: "Existing notice" }
  await savePart(
    footer,
    { fields: [], values, entry: { id: "house-id" } as never },
    { ...values, colophon: "New footer", phone: "must not be saved" },
  )
  expect(save).toHaveBeenCalledWith("house-id", { data: { colophon: "New footer" } })
})

test("a first menu edit preserves fallback links and the exact template handle", async () => {
  const defaults = [
    { label: "Home", url: "/" },
    { label: "Contact", url: "/contact" },
  ]
  const part: SharedPart = {
    id: "navigation",
    label: "Top navigation",
    description: "All pages",
    selector: "nav",
    source: { kind: "menu", name: "main", label: "Top navigation", defaults },
  }
  const list = spyOn(api, "menus").mockResolvedValue([])
  const create = spyOn(api, "createMenu").mockResolvedValue({} as never)
  mocks.push(list, create)
  const loaded = await loadPart(part)
  expect(loaded.values.items).toEqual(defaults)
  const items = [defaults[0], { label: "Get in touch", url: "/contact" }]
  await savePart(part, loaded, { items })
  expect(create).toHaveBeenCalledWith("Top navigation", items, "main")
})

test("a failed source read never presents an empty replacement menu", async () => {
  mocks.push(spyOn(api, "menus").mockRejectedValue(new Error("Offline")))
  const part: SharedPart = { ...footer, source: { kind: "menu", name: "main", label: "Main" } }
  await expect(loadPart(part)).rejects.toThrow("Offline")
})
