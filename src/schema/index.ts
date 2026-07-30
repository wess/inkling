import { column, defineSchema } from "@atlas/db"

// The TypeScript mirror of `migrations/`. Migrations are the runtime source of
// truth — this file is what gives queries their row types. When you change one,
// change both. Column names are snake_case because @atlas/db emits identifiers
// unquoted: Postgres folds unquoted camelCase to lowercase while SQLite keeps
// it, so a camelCase column would come back as `contenttypeid` on one driver
// and `contentTypeId` on the other. snake_case is identical on both.

export const users = defineSchema("users", {
  id: column.text().primaryKey(),
  email: column.text().unique(),
  name: column.text(),
  role: column.text().default("editor"),
  password_hash: column.text(),
  avatar_id: column.text().nullable(),
  created_at: column.text(),
  updated_at: column.text(),
  last_seen_at: column.text().nullable(),
  deleted_at: column.text().nullable(),
})

export const sessions = defineSchema("sessions", {
  id: column.text().primaryKey(),
  user_id: column.text().ref("users", "id"),
  ip: column.text().nullable(),
  user_agent: column.text().nullable(),
  created_at: column.text(),
  last_used_at: column.text().nullable(),
  expires_at: column.text(),
  revoked_at: column.text().nullable(),
})

// A content type is a user-defined shape. `fields` holds the ordered field
// definitions (see src/fields) as JSON. `owner_plugin` is set when a plugin
// declared the type, which makes it read-only in the UI and lets disabling the
// plugin clean up after itself.
export const contentTypes = defineSchema("content_types", {
  id: column.text().primaryKey(),
  name: column.text().unique(),
  label: column.text(),
  plural_label: column.text(),
  description: column.text().nullable(),
  kind: column.text().default("collection"),
  preview_url: column.text().nullable(),
  fields: column.text(),
  icon: column.text().nullable(),
  sort_order: column.integer().default(0),
  owner_plugin: column.text().nullable(),
  created_at: column.text(),
  updated_at: column.text(),
})

export const entries = defineSchema("entries", {
  id: column.text().primaryKey(),
  content_type_id: column.text().ref("content_types", "id"),
  slug: column.text(),
  title: column.text(),
  data: column.text(),
  status: column.text().default("draft"),
  locale: column.text().default("en"),
  author_id: column.text().nullable(),
  sort_order: column.integer().default(0),
  published_at: column.text().nullable(),
  scheduled_at: column.text().nullable(),
  created_at: column.text(),
  updated_at: column.text(),
  deleted_at: column.text().nullable(),
})

export const revisions = defineSchema("revisions", {
  id: column.text().primaryKey(),
  entry_id: column.text().ref("entries", "id"),
  title: column.text(),
  data: column.text(),
  status: column.text(),
  author_id: column.text().nullable(),
  note: column.text().nullable(),
  created_at: column.text(),
})

export const media = defineSchema("media", {
  id: column.text().primaryKey(),
  filename: column.text(),
  storage_key: column.text(),
  url: column.text(),
  mime: column.text(),
  size: column.integer(),
  width: column.integer().nullable(),
  height: column.integer().nullable(),
  alt: column.text().nullable(),
  caption: column.text().nullable(),
  folder: column.text().nullable(),
  uploaded_by: column.text().nullable(),
  created_at: column.text(),
  deleted_at: column.text().nullable(),
})

export const taxonomies = defineSchema("taxonomies", {
  id: column.text().primaryKey(),
  name: column.text().unique(),
  label: column.text(),
  hierarchical: column.integer().default(0),
  owner_plugin: column.text().nullable(),
  created_at: column.text(),
})

export const terms = defineSchema("terms", {
  id: column.text().primaryKey(),
  taxonomy_id: column.text().ref("taxonomies", "id"),
  parent_id: column.text().nullable(),
  slug: column.text(),
  label: column.text(),
  description: column.text().nullable(),
  sort_order: column.integer().default(0),
  created_at: column.text(),
})

export const entryTerms = defineSchema("entry_terms", {
  entry_id: column.text().ref("entries", "id"),
  term_id: column.text().ref("terms", "id"),
})

export const menus = defineSchema("menus", {
  id: column.text().primaryKey(),
  name: column.text().unique(),
  label: column.text(),
  items: column.text(),
  created_at: column.text(),
  updated_at: column.text(),
})

// Site-wide settings and per-plugin settings share one table. `scope` is
// "site" for core settings or the plugin name for plugin-owned ones, so a
// plugin's settings vanish with it and can never collide with core keys.
export const settings = defineSchema("settings", {
  scope: column.text(),
  key: column.text(),
  value: column.text(),
  updated_at: column.text(),
})

export const apiKeys = defineSchema("api_keys", {
  id: column.text().primaryKey(),
  name: column.text(),
  hashed_key: column.text().unique(),
  prefix: column.text(),
  scopes: column.text(),
  created_by: column.text().nullable(),
  created_at: column.text(),
  last_used_at: column.text().nullable(),
  expires_at: column.text().nullable(),
  revoked_at: column.text().nullable(),
})

export const webhooks = defineSchema("webhooks", {
  id: column.text().primaryKey(),
  name: column.text(),
  url: column.text(),
  events: column.text(),
  secret: column.text(),
  active: column.integer().default(1),
  created_at: column.text(),
  last_status: column.integer().nullable(),
  last_fired_at: column.text().nullable(),
})

export const plugins = defineSchema("plugins", {
  name: column.text().primaryKey(),
  version: column.text(),
  enabled: column.integer().default(0),
  installed_at: column.text(),
  updated_at: column.text(),
})

export const auditEvents = defineSchema("audit_events", {
  id: column.text().primaryKey(),
  user_id: column.text().nullable(),
  event: column.text(),
  metadata: column.text().nullable(),
  ip: column.text().nullable(),
  user_agent: column.text().nullable(),
  created_at: column.text(),
})

export const rateLimits = defineSchema("rate_limits", {
  bucket: column.text().primaryKey(),
  count: column.integer(),
  window_started_at: column.text(),
})

export const schemas = [
  users,
  sessions,
  contentTypes,
  entries,
  revisions,
  media,
  taxonomies,
  terms,
  entryTerms,
  menus,
  settings,
  apiKeys,
  webhooks,
  plugins,
  auditEvents,
  rateLimits,
]
