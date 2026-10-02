import type { Connection } from "atlas/db"
import { get, json, pipeline, type Route } from "atlas/server"
import { requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import type { MenuItem } from "../menus/index.ts"

export type SharedPart = {
  id: string
  label: string
  description: string
  selector: string
  source:
    | { kind: "entry"; type: string; fields: string[] }
    | { kind: "settings"; fields: string[] }
    | { kind: "menu"; name: string; label: string; defaults?: MenuItem[] }
}

export type Website = { previewUrl: string; parts: SharedPart[] }

export const websiteRoutes = (db: Connection, website: Website): Route[] => [
  get(
    "/website",
    pipeline(requireAuth(db), requireCan(can.readContent, "read content"))(c => json(c, 200, website)),
  ),
]
