import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Route } from "atlas/server"
import { badRequest, conflict, del, get, json, notFound, parseJson, pipeline, post, put } from "atlas/server"
import { requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { body, optionalText, requireText } from "../http/index.ts"
import { id, isHandle, slugify } from "../ids/index.ts"
import { decodeArray, encode } from "../json/index.ts"
import { menus } from "../schema/index.ts"
import { now } from "../time/index.ts"

export type MenuItem = {
  readonly label: string
  readonly url?: string
  readonly entryId?: string
  readonly target?: "_self" | "_blank"
  readonly children?: readonly MenuItem[]
}

type MenuRow = {
  id: string
  name: string
  label: string
  items: string
  created_at: string
  updated_at: string
}

const present = (row: MenuRow) => ({
  id: row.id,
  name: row.name,
  label: row.label,
  items: decodeArray<MenuItem>(row.items),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const MAX_DEPTH = 4

// Exported so a proposal can be checked against the same rule the write path
// enforces, rather than only failing at apply time in front of an editor.
export const safeUrl = (value: string): boolean => {
  if (value.startsWith("/") || value.startsWith("#")) return true
  try {
    const url = new URL(value)
    return (
      url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" || url.protocol === "tel:"
    )
  } catch {
    return false
  }
}

// Menus nest, so a malformed payload could nest without bound or carry an
// arbitrary object graph. Normalizing rebuilds the tree from only the fields
// that exist, which both validates and strips anything extra.
const normalize = (input: unknown, depth = 0): MenuItem[] => {
  if (!Array.isArray(input)) throw badRequest("Menu items must be an array", { code: "BAD_ITEMS" })
  if (depth >= MAX_DEPTH) throw badRequest(`Menus can nest at most ${MAX_DEPTH} levels deep`, { code: "TOO_DEEP" })

  return input.map(raw => {
    const node = (raw ?? {}) as Record<string, unknown>
    const label = typeof node.label === "string" ? node.label.trim() : ""
    if (!label) throw badRequest("Every menu item needs a label", { code: "BAD_ITEM" })

    const url = typeof node.url === "string" && node.url.trim() !== "" ? node.url.trim() : undefined
    const entryId = typeof node.entryId === "string" && node.entryId.trim() !== "" ? node.entryId.trim() : undefined
    if (!url && !entryId && !Array.isArray(node.children)) {
      throw badRequest(`"${label}" needs a url, an entryId, or children`, { code: "BAD_ITEM" })
    }
    if (url && !safeUrl(url)) {
      throw badRequest(`"${label}" has an invalid link`, { code: "BAD_ITEM" })
    }
    if (url && entryId) throw badRequest(`"${label}" cannot use both a url and an entryId`, { code: "BAD_ITEM" })

    return {
      label,
      ...(url ? { url } : {}),
      ...(entryId ? { entryId } : {}),
      ...(node.target === "_blank" ? { target: "_blank" as const } : {}),
      ...(Array.isArray(node.children) && node.children.length > 0
        ? { children: normalize(node.children, depth + 1) }
        : {}),
    }
  })
}

export const menuRoutes = (db: Connection): Route[] => {
  const read = pipeline(requireAuth(db))
  const write = pipeline(requireAuth(db), requireCan(can.manageMenus, "manage menus"), parseJson)
  const act = pipeline(requireAuth(db), requireCan(can.manageMenus, "manage menus"))

  return [
    get(
      "/menus",
      read(async c => {
        const rows = await db.all<MenuRow>(from(menus).orderBy("label", "ASC"))
        return json(c, 200, { data: rows.map(present) })
      }),
    ),

    get(
      "/menus/:name",
      read(async c => {
        const row = await db.one<MenuRow>(from(menus).where(q => q("name").equals(c.params.name ?? "")))
        if (!row) throw notFound("Menu not found")
        return json(c, 200, present(row))
      }),
    ),

    post(
      "/menus",
      write(async c => {
        const input = body(c)
        const label = requireText(input, "label", "Label")
        const name = slugify(String(input.name ?? label)).replace(/-/g, "")
        if (!isHandle(name)) throw badRequest("Name must be lowercase letters and digits", { code: "BAD_NAME" })

        const existing = await db.one(from(menus).where(q => q("name").equals(name)))
        if (existing) throw conflict(`A menu named "${name}" already exists`, { code: "DUPLICATE" })

        const timestamp = now()
        const row: MenuRow = {
          id: id(),
          name,
          label,
          items: encode(normalize(input.items ?? [])),
          created_at: timestamp,
          updated_at: timestamp,
        }
        await db.execute(from(menus).insert(row))
        return json(c, 201, present(row))
      }),
    ),

    put(
      "/menus/:name",
      write(async c => {
        const row = await db.one<MenuRow>(from(menus).where(q => q("name").equals(c.params.name ?? "")))
        if (!row) throw notFound("Menu not found")

        const input = body(c)
        const changes: Record<string, unknown> = { updated_at: now() }
        if (input.label !== undefined) changes.label = optionalText(input, "label") ?? row.label
        if (input.items !== undefined) changes.items = encode(normalize(input.items))

        await db.execute(
          from(menus)
            .update(changes)
            .where(q => q("id").equals(row.id)),
        )
        return json(c, 200, present({ ...row, ...changes } as MenuRow))
      }),
    ),

    del(
      "/menus/:name",
      act(async c => {
        const row = await db.one<MenuRow>(from(menus).where(q => q("name").equals(c.params.name ?? "")))
        if (!row) throw notFound("Menu not found")
        await db.execute(
          from(menus)
            .where(q => q("id").equals(row.id))
            .del(),
        )
        return json(c, 200, { deleted: true })
      }),
    ),
  ]
}
