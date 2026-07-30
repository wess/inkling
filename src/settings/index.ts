import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Route } from "@atlas/server"
import { badRequest, get, json, parseJson, pipeline, put } from "@atlas/server"
import { requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { body } from "../http/index.ts"
import { decode, encode } from "../json/index.ts"
import { media, settings } from "../schema/index.ts"
import { now } from "../time/index.ts"

export const SITE_SCOPE = "site"

// Core site settings. Keys not in this registry are rejected so the table can't
// become a dumping ground; plugins get their own scope and declare their own.
const SITE_REGISTRY = {
  title: { default: "Inkling", type: "text", label: "Site title" },
  tagline: { default: "", type: "text", label: "Tagline" },
  description: { default: "", type: "textarea", label: "Description" },
  url: { default: "", type: "text", label: "Public site URL" },
  locale: { default: "en", type: "text", label: "Default locale" },
  timezone: { default: "UTC", type: "text", label: "Timezone" },
  logoId: { default: null, type: "media", label: "Logo" },
  faviconId: { default: null, type: "media", label: "Favicon" },
  socialImageId: { default: null, type: "media", label: "Default social image" },
} as const

export type SiteSettingKey = keyof typeof SITE_REGISTRY

export const isSiteSetting = (key: string): key is SiteSettingKey => key in SITE_REGISTRY

export const readSetting = async <T>(db: Connection, scope: string, key: string, fallback: T): Promise<T> => {
  const row = await db.one<{ value: string }>(
    from(settings)
      .select("value")
      .where(q => q("scope").equals(scope))
      .where(q => q("key").equals(key)),
  )
  return row ? decode<T>(row.value, fallback) : fallback
}

export const writeSetting = async (db: Connection, scope: string, key: string, value: unknown): Promise<void> => {
  await db.execute(
    from(settings)
      .insert({ scope, key, value: encode(value), updated_at: now() })
      .onConflict({ target: ["scope", "key"], action: "update" }),
  )
}

export const readScope = async (db: Connection, scope: string): Promise<Record<string, unknown>> => {
  const rows = await db.all<{ key: string; value: string }>(
    from(settings)
      .select("key", "value")
      .where(q => q("scope").equals(scope)),
  )
  return Object.fromEntries(rows.map(row => [row.key, decode<unknown>(row.value, null)]))
}

export const clearScope = async (db: Connection, scope: string): Promise<void> => {
  await db.execute(
    from(settings)
      .where(q => q("scope").equals(scope))
      .del(),
  )
}

export const siteSettings = async (db: Connection): Promise<Record<string, unknown>> => {
  const stored = await readScope(db, SITE_SCOPE)
  const defaults = Object.fromEntries(Object.entries(SITE_REGISTRY).map(([key, spec]) => [key, spec.default]))
  return { ...defaults, ...stored }
}

export const settingsRoutes = (db: Connection): Route[] => {
  const read = pipeline(requireAuth(db))
  const write = pipeline(requireAuth(db), requireCan(can.manageSettings, "change site settings"), parseJson)

  const validateSetting = async (key: SiteSettingKey, value: unknown): Promise<unknown> => {
    if (key === "logoId" || key === "faviconId" || key === "socialImageId") {
      if (value === null || value === "") return null
      if (typeof value !== "string") throw badRequest(`${SITE_REGISTRY[key].label} must be a media item`)
      const exists = await db.one<{ id: string }>(
        from(media)
          .select("id")
          .where(q => q("id").equals(value))
          .where(q => q("deleted_at").isNull()),
      )
      if (!exists) throw badRequest(`${SITE_REGISTRY[key].label} is unavailable`, { code: "BAD_MEDIA" })
      return value
    }
    if (typeof value !== "string") throw badRequest(`${SITE_REGISTRY[key].label} must be text`)
    const text = value.trim()
    if (key === "title" && !text) throw badRequest("Site title cannot be empty", { code: "BAD_TITLE" })
    if (key === "url" && text) {
      try {
        const parsed = new URL(text)
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol")
        return parsed.toString().replace(/\/$/, "")
      } catch {
        throw badRequest("Public site URL must be an absolute http(s) URL", { code: "BAD_URL" })
      }
    }
    if (key === "locale" && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(text)) {
      throw badRequest("Default locale must look like en or en-US", { code: "BAD_LOCALE" })
    }
    if (key === "timezone") {
      try {
        new Intl.DateTimeFormat("en", { timeZone: text }).format()
      } catch {
        throw badRequest("Timezone must be an IANA name such as America/New_York", { code: "BAD_TIMEZONE" })
      }
    }
    return text
  }

  return [
    get(
      "/settings",
      read(async c =>
        json(c, 200, {
          data: await siteSettings(db),
          schema: Object.entries(SITE_REGISTRY).map(([key, spec]) => ({
            key,
            label: spec.label,
            type: spec.type,
            default: spec.default,
          })),
        }),
      ),
    ),

    put(
      "/settings",
      write(async c => {
        const input = body(c)
        const unknownKeys = Object.keys(input).filter(key => !isSiteSetting(key))
        if (unknownKeys.length > 0) {
          throw badRequest(`Unknown setting${unknownKeys.length > 1 ? "s" : ""}: ${unknownKeys.join(", ")}`, {
            code: "UNKNOWN_SETTING",
          })
        }

        const validated = await Promise.all(
          Object.entries(input).map(
            async ([key, value]) => [key, await validateSetting(key as SiteSettingKey, value)] as const,
          ),
        )
        await db.transaction(async tx => {
          for (const [key, value] of validated) await writeSetting(tx, SITE_SCOPE, key, value)
        })
        return json(c, 200, { data: await siteSettings(db) })
      }),
    ),
  ]
}
