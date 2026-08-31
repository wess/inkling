import { column, defineSchema } from "atlas/db"

// The TypeScript mirror of `migrations/`. Migrations are the runtime source of
// truth — this file is what gives queries their row types. When you change one,
// change both. Column names are snake_case because atlas/db emits identifiers
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

// A machine's credential for the admin API, narrower than the account behind
// it. `grants` is a JSON array of capability names from src/auth/roles.ts, and
// the effective permission is always that list intersected with the live role of
// `user_id` — see src/auth/guard.ts#allows.
export const agentKeys = defineSchema("agent_keys", {
  id: column.text().primaryKey(),
  name: column.text(),
  hashed_key: column.text().unique(),
  prefix: column.text(),
  grants: column.text(),
  user_id: column.text().ref("users", "id"),
  created_at: column.text(),
  last_used_at: column.text().nullable(),
  last_ip: column.text().nullable(),
  expires_at: column.text(),
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

// AI provider credentials. `ciphertext`/`iv` hold the operator's key under
// AES-GCM; nothing here is ever presented to a client except `hint`, which is
// the last few characters so two keys can be told apart in a list.
export const aiCredentials = defineSchema("ai_credentials", {
  id: column.text().primaryKey(),
  provider: column.text(),
  label: column.text(),
  model: column.text(),
  base_url: column.text().nullable(),
  ciphertext: column.text(),
  iv: column.text(),
  hint: column.text(),
  is_default: column.integer().default(0),
  created_by: column.text().nullable(),
  created_at: column.text(),
  updated_at: column.text(),
  last_used_at: column.text().nullable(),
  revoked_at: column.text().nullable(),
  // "key" or "oauth". An OAuth connection keeps its access token in the same
  // ciphertext/iv pair a key uses, and adds what a key has no need for.
  auth_kind: column.text().default("key"),
  refresh_ciphertext: column.text().nullable(),
  refresh_iv: column.text().nullable(),
  expires_at: column.text().nullable(),
  scope: column.text().nullable(),
  account: column.text().nullable(),
})

// An authorized account on one network. Same sealing as ai_credentials, and
// for the same reason it is not a content type: every content type is readable
// through an editor screen, a revision, the search index, and the delivery API,
// and a refresh token belongs in none of those.
export const socialAccounts = defineSchema("social_accounts", {
  id: column.text().primaryKey(),
  network: column.text(),
  client_id: column.text().default(""),
  account_name: column.text().nullable(),
  account_id: column.text().nullable(),
  scope: column.text().nullable(),
  access_ct: column.text(),
  access_iv: column.text(),
  refresh_ct: column.text().nullable(),
  refresh_iv: column.text().nullable(),
  expires_at: column.text().nullable(),
  error: column.text().nullable(),
  connected_by: column.text().nullable(),
  connected_at: column.text(),
  updated_at: column.text(),
  // Per-network detail with no cross-network meaning: a Facebook page id, a
  // YouTube channel, an avatar. JSON, so adding a network adds no column.
  meta: column.text().nullable(),
})

// The developer app registered with one network. The secret is sealed under
// SECRET like every other credential here — deliberately not a `settings` row,
// which is read wholesale and handed to plugin panels.
export const socialApps = defineSchema("social_apps", {
  network: column.text().primaryKey(),
  enabled: column.integer().default(1),
  client_id: column.text().default(""),
  secret_ct: column.text().nullable(),
  secret_iv: column.text().nullable(),
  secret_hint: column.text().nullable(),
  authorize_url: column.text().nullable(),
  token_url: column.text().nullable(),
  scopes: column.text().nullable(),
  updated_by: column.text().nullable(),
  updated_at: column.text(),
})

// A composed post, before it belongs to any one network.
export const socialPosts = defineSchema("social_posts", {
  id: column.text().primaryKey(),
  title: column.text().default(""),
  caption: column.text().default(""),
  link: column.text().nullable(),
  media: column.text().default("[]"),
  status: column.text().default("draft"),
  scheduled_at: column.text().nullable(),
  published_at: column.text().nullable(),
  created_by: column.text().nullable(),
  created_at: column.text(),
  updated_at: column.text(),
  deleted_at: column.text().nullable(),
})

// One row per (post, account). `network` is denormalized so a disconnected
// account cannot take the record of where a post went out with it.
export const socialTargets = defineSchema("social_targets", {
  id: column.text().primaryKey(),
  post_id: column.text(),
  account_id: column.text().nullable(),
  network: column.text(),
  caption: column.text().nullable(),
  options: column.text().default("{}"),
  status: column.text().default("pending"),
  remote_id: column.text().nullable(),
  remote_url: column.text().nullable(),
  error: column.text().nullable(),
  error_code: column.text().nullable(),
  attempts: column.integer().default(0),
  next_attempt_at: column.text().nullable(),
  posted_at: column.text().nullable(),
  created_at: column.text(),
  updated_at: column.text(),
})

// One visitor's live conversation with the public assistant. The browser holds
// only the id: turns kept here cannot be forged by the client that is talking
// to them. Swept on TTL rather than retained — see the migration.
export const publicAiSessions = defineSchema("public_ai_sessions", {
  id: column.text().primaryKey(),
  turns: column.text().default("[]"),
  turn_count: column.integer().default(0),
  created_at: column.text(),
  last_seen_at: column.text(),
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
  agentKeys,
  webhooks,
  plugins,
  auditEvents,
  rateLimits,
  aiCredentials,
  socialApps,
  socialAccounts,
  socialPosts,
  socialTargets,
  publicAiSessions,
]
