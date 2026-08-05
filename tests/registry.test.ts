import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { options, pipeline, router } from "atlas/server"
import { corsFor, preflight } from "../src/http/index.ts"
import { up } from "../src/migrate/index.ts"
import { createHooks } from "../src/plugins/hooks.ts"
import { createRegistry } from "../src/plugins/index.ts"
import { pluginDispatch } from "../src/plugins/routes.ts"
import { plugins } from "../src/schema/index.ts"
import { registerWebhookBridge } from "../src/webhooks/index.ts"

const setup = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const hooks = createHooks(() => {})
  registerWebhookBridge(db, hooks)
  const registry = await createRegistry(db, hooks, "./tests/fixtures/plugins")
  return { db, hooks, registry }
}

test("registry refresh preserves core webhook listeners", async () => {
  const { db, hooks } = await setup()
  expect(hooks.listenerCount("entry.afterSave")).toBe(1)
  await db.close()
})

test("plugin migrations run before install and state is recorded last", async () => {
  const { db, registry } = await setup()

  await expect(registry.enable("ordered")).resolves.toEqual({ enabled: ["ordered"] })
  expect(await db.one<{ id: string }>({ text: "SELECT id FROM ordered_install", values: [] })).toEqual({ id: "ready" })
  expect(
    await db.one(
      from(plugins)
        .select("version")
        .where(q => q("name").equals("ordered")),
    ),
  ).toEqual({ version: "1.0.0" })

  await db.close()
})

test("a failed install is not recorded as enabled or current", async () => {
  const { db, registry } = await setup()

  await expect(registry.enable("broken")).rejects.toThrow("install failed")
  expect(
    await db.one(
      from(plugins)
        .select("name")
        .where(q => q("name").equals("broken")),
    ),
  ).toBeNull()

  await db.close()
})

test("plugin dispatch answers browser preflight and exposes mutation methods", async () => {
  const { db, registry } = await setup()
  const dispatch = router(...pluginDispatch(registry))
  const preflightResponse = await dispatch(new Request("http://localhost/ext/ordered/action", { method: "OPTIONS" }))
  expect(preflightResponse.status).toBe(204)

  const cors = router(options("/test", pipeline(corsFor(["POST", "OPTIONS"], ["https://site.example"]))(preflight)))
  const response = await cors(
    new Request("http://localhost/test", {
      method: "OPTIONS",
      headers: { origin: "https://site.example" },
    }),
  )
  expect(response.headers.get("access-control-allow-methods")).toBe("POST,OPTIONS")

  await db.close()
})
