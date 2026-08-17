// Typed client for the admin API. Everything goes through /api/*, which
// src/web/serve.ts proxies to the API process — the browser never talks to the
// API port directly, so the bearer token rides one origin.

const TOKEN_KEY = "inkling_token"

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY)
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token)
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY)

export type ApiError = Error & { status: number; code?: string; details?: unknown }

const fail = (status: number, message: string, code?: string, details?: unknown): ApiError => {
  const error = new Error(message) as ApiError
  error.status = status
  error.code = code
  error.details = details
  return error
}

type Options = { method?: string; body?: unknown; form?: FormData; query?: Record<string, string | number | undefined> }

export const request = async <T>(path: string, options: Options = {}): Promise<T> => {
  // Everything the admin owns lives under /api. A plugin's own routes do not:
  // they are mounted at /ext on the root, so a panel endpoint is passed through
  // as written. Prefixing it produced /api/ext/… — which matches nothing, falls
  // through to the SPA, and comes back as HTML with a 200.
  const url = new URL(path.startsWith("/ext/") ? path : `/api${path}`, location.origin)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value))
  }

  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  if (options.body !== undefined) headers["content-type"] = "application/json"

  const response = await fetch(url, {
    method: options.method ?? (options.body !== undefined || options.form ? "POST" : "GET"),
    headers,
    body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
  })

  if (response.status === 204) return undefined as T

  const payload = await response.json().catch(() => ({}) as Record<string, unknown>)

  if (!response.ok) {
    // A dead session should drop the user at the login screen rather than
    // leaving every panel showing its own 401.
    if (response.status === 401) clearToken()
    throw fail(
      response.status,
      typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`,
      payload.code as string | undefined,
      payload.details,
    )
  }

  return payload as T
}

export type Identity = { id: string; email: string; name: string; role: string; avatarId: string | null }

export type FieldOption = { value: string; label: string }

export type Field = {
  key: string
  type: string
  label: string
  help?: string
  required?: boolean
  localized?: boolean
  multiple?: boolean
  default?: unknown
  options?: FieldOption[]
  min?: number
  max?: number
  pattern?: string
  of?: string
  fields?: Field[]
}

export type ContentType = {
  id: string
  name: string
  label: string
  pluralLabel: string
  description: string | null
  kind: "collection" | "single"
  previewUrl: string | null
  fields: Field[]
  icon: string | null
  sortOrder: number
  ownerPlugin: string | null
  entryCount?: number
}

export type Entry = {
  id: string
  type?: string
  contentTypeId: string
  slug: string
  title: string
  data: Record<string, unknown>
  status: string
  locale: string
  authorId: string | null
  sortOrder: number
  publishedAt: string | null
  scheduledAt: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

// A machine's credential for this API — an MCP server, a build script. Narrower
// than the account that minted it and revocable on its own; see src/agents.
export type AgentKey = {
  id: string
  name: string
  prefix: string
  grants: string[]
  userId: string
  createdAt: string
  lastUsedAt: string | null
  lastIp: string | null
  expiresAt: string
  revokedAt: string | null
  active: boolean
}

export type Media = {
  id: string
  filename: string
  url: string
  mime: string
  size: number
  width: number | null
  height: number | null
  alt: string | null
  caption: string | null
  folder: string | null
  createdAt: string
  deletedAt: string | null
}

export type PluginPanel = {
  id: string
  label: string
  icon?: string
  kind: "settings" | "collection" | "table" | "stats" | "connections"
  contentType?: string
  endpoint?: string
  columns?: { key: string; label: string }[]
  ranges?: number[]
  description?: string
}

// Mirrors PluginStats in src/plugins/define.ts. Values arrive pre-formatted —
// the plugin decides what a number means and how it reads.
export type PluginStatsPayload = {
  tiles: { label: string; value: string; hint?: string }[]
  series?: { label: string; points: { label: string; value: number }[] }
  tables?: { label: string; columns: { key: string; label: string }[]; rows: Record<string, string | number>[] }[]
}

// Mirrors PluginConnections in src/plugins/define.ts.
export type PluginConnectionsPayload = {
  redirectUri?: string
  connections: {
    id: string
    label: string
    configured: boolean
    scopes?: string[]
    connection: {
      id: string
      account: string | null
      expiresAt: string | null
      error: string | null
      connectedAt: string
    } | null
  }[]
}

export type PluginSetting = {
  key: string
  label: string
  type: "text" | "textarea" | "number" | "boolean" | "select"
  help?: string
  default?: unknown
  options?: FieldOption[]
}

export type Plugin = {
  name: string
  label: string
  version: string
  description: string | null
  author: string | null
  requires: string[]
  enabled: boolean
  installedVersion: string | null
  error: string | null
  upgradable: boolean
  contentTypes: string[]
  taxonomies: string[]
  panels: PluginPanel[]
  settings: PluginSetting[]
  settingsValues?: Record<string, unknown>
}

export type Taxonomy = {
  id: string
  name: string
  label: string
  hierarchical: boolean
  ownerPlugin: string | null
}

export type Term = {
  id: string
  taxonomyId: string
  parentId: string | null
  slug: string
  label: string
  description: string | null
  sortOrder: number
}

export type MenuItem = {
  label: string
  url?: string
  entryId?: string
  target?: "_self" | "_blank"
  children?: MenuItem[]
}

export type Menu = { id: string; name: string; label: string; items: MenuItem[] }

// ---------------------------------------------------------------- social

export type SocialAccount = {
  id: string
  network: string
  account: string | null
  accountId: string | null
  scope: string | null
  expiresAt: string | null
  // The network's own words when a renewal failed. Its presence is what turns
  // a row amber; ours would be a summary of the sentence needed to fix it.
  error: string | null
  connectedAt: string
  meta: Record<string, unknown>
}

export type SocialNetworkOption = {
  key: string
  label: string
  type: "text" | "textarea" | "select" | "boolean"
  choices?: { value: string; label: string }[]
  fallback?: string | boolean
  help?: string
}

export type SocialNetwork = {
  value: string
  label: string
  limit: number
  media: { images: number; video: boolean; requiresMedia: false | "video" | "image" | "any"; coverImage?: true }
  options: SocialNetworkOption[]
  help: string
  // Whether this install has a developer app set up and switched on, not
  // whether the network has an OAuth flow — no app means no button.
  configured: boolean
  accounts: SocialAccount[]
}

// The developer app for one network. The secret never crosses this boundary —
// `secretHint` is its last four characters, which is enough to recognise
// against a developer console and useless to anyone else.
export type SocialApp = {
  network: string
  enabled: boolean
  clientId: string
  secretHint: string | null
  hasSecret: boolean
  authorizeUrl: string | null
  tokenUrl: string | null
  scopes: string | null
  updatedAt: string
  // Where the credentials came from. "environment" is read-only here, and the
  // screen says so rather than letting a save silently shadow it.
  source: "admin" | "environment" | "none"
}

// The step-by-step for getting a network's two values out of its own console.
// Sent with the payload rather than built into the bundle, so a console that
// moves is a server-side correction rather than a release of the admin.
export type SocialGuide = {
  summary: string
  time: string
  steps: { title: string; body: string }[]
  gotchas: string[]
}

export type SocialSetting = {
  value: string
  label: string
  help: string
  console: string
  scopes: string[]
  defaults: { authorizeUrl: string; tokenUrl: string }
  // Networks that fetch media from your site rather than being handed it, and
  // therefore need PUBLIC_URL to be reachable.
  fetchesMedia: boolean
  ready: boolean
  app: SocialApp
  guide: SocialGuide | null
}

export type SocialAppInput = {
  enabled: boolean
  clientId: string
  // Omitted means "keep the stored one" — the form never echoes it back, so
  // sending an empty string on every save would wipe it.
  clientSecret?: string
  authorizeUrl: string | null
  tokenUrl: string | null
  scopes: string | null
}

export type SocialTarget = {
  id: string
  accountId: string | null
  network: string
  networkLabel: string
  account: string | null
  connected: boolean
  // null means "follow the post's caption"; "" means this network gets none.
  caption: string | null
  options: Record<string, unknown>
  status: "pending" | "publishing" | "posted" | "failed" | "skipped"
  remoteId: string | null
  url: string | null
  error: string | null
  attempts: number
  postedAt: string | null
}

export type SocialPost = {
  id: string
  title: string
  caption: string
  link: string | null
  media: string[]
  status: "draft" | "scheduled" | "publishing" | "posted" | "partial" | "failed" | "canceled"
  scheduledAt: string | null
  publishedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
  targets: SocialTarget[]
}

export type SocialPostInput = {
  title: string
  caption: string
  link: string | null
  media: string[]
  scheduledAt: string | null
  targets: { accountId: string; caption: string | null; options: Record<string, unknown> }[]
}

export type SocialOverview = {
  counts: { drafts: number; scheduled: number; posted: number; partial: number; failed: number }
  upcoming: SocialPost[]
  recent: SocialPost[]
  accounts: SocialAccount[]
  connectable: { value: string; label: string }[]
  unconfigured: number
}

export type SocialOutcome = {
  postId: string
  status: string
  targets: { id: string; network: string; status: string; error: string | null }[]
}

export type Webhook = {
  id: string
  name: string
  url: string
  events: string[]
  active: boolean
  createdAt: string
  lastStatus: number | null
  lastFiredAt: string | null
}

export type Stats = {
  entries: number
  published: number
  drafts: number
  review: number
  scheduled: number
  media: number
  types: number
  recent: { id: string; title: string; status: string; updatedAt: string; type: string }[]
}

export type AuditEvent = {
  id: string
  event: string
  metadata: Record<string, unknown> | null
  ip: string | null
  userName: string | null
  createdAt: string
}

export type AiProvider = {
  name: string
  label: string
  defaultModel: string
  needsKey: boolean
  needsBaseUrl: boolean
  models: string[]
  help: string
  // Whether this install can start an OAuth flow right now, not whether the
  // provider has one — an unregistered client means no button.
  oauth: boolean
}

export type AiCredential = {
  id: string
  provider: string
  label: string
  model: string
  baseUrl: string | null
  hint: string
  isDefault: boolean
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  authKind: "key" | "oauth"
  account: string | null
  expiresAt: string | null
  scope: string | null
}

// Mirrors Proposal in src/ai/tools.ts. Nothing here has been saved — each one
// is applied by sending it back through the ordinary content routes.
export type AgentProposal =
  | {
      kind: "entry.update"
      id: string
      summary: string
      entryId: string
      entryTitle: string
      typeName: string
      patch: Record<string, unknown>
      before: Record<string, unknown>
    }
  | { kind: "entry.create"; id: string; summary: string; typeName: string; payload: Record<string, unknown> }
  | {
      kind: "type.update"
      id: string
      summary: string
      typeName: string
      patch: Record<string, unknown>
      before: Record<string, unknown>
    }
  | { kind: "type.create"; id: string; summary: string; typeName: string; payload: Record<string, unknown> }
  | {
      kind: "entry.status"
      id: string
      summary: string
      entryId: string
      entryTitle: string
      from: string
      to: string
    }
  | {
      kind: "settings.update"
      id: string
      summary: string
      patch: Record<string, unknown>
      before: Record<string, unknown>
    }
  | {
      kind: "menu.update"
      id: string
      summary: string
      menuName: string
      menuLabel: string
      patch: Record<string, unknown>
      before: Record<string, unknown>
    }

export type AgentEvent =
  | { type: "start"; provider: string; model: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "proposal"; proposal: AgentProposal }
  | { type: "done"; history: unknown[]; proposals: AgentProposal[] }
  | { type: "error"; message: string }

// Server-sent events, hand-parsed because the browser's EventSource cannot set
// an Authorization header and this API has no cookie to fall back on.
export const runAgent = async (
  input: { message: string; history?: unknown[]; entryId?: string; type?: string; screen?: string },
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> => {
  const headers: Record<string, string> = { "content-type": "application/json" }
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`

  const response = await fetch(new URL("/api/ai/agent", location.origin), {
    method: "POST",
    headers,
    body: JSON.stringify(input),
    signal,
  })

  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string; code?: string }
    if (response.status === 401) clearToken()
    throw fail(response.status, payload.error ?? `Request failed (${response.status})`, payload.code)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Frames are separated by a blank line; a partial one stays in the buffer.
    let boundary = buffer.indexOf("\n\n")
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf("\n\n")

      const name = frame.match(/^event: (.+)$/m)?.[1]
      const data = frame.match(/^data: (.+)$/m)?.[1]
      if (!name || !data) continue
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        onEvent(
          name === "proposal"
            ? ({ type: "proposal", proposal: parsed as unknown as AgentProposal } as AgentEvent)
            : ({ type: name, ...parsed } as AgentEvent),
        )
      } catch {
        // A frame we cannot parse is a frame we cannot act on. Dropping it beats
        // ending a run that is otherwise fine.
      }
    }
  }
}

type Wrapped<T> = { data: T }
type Paged<T> = { data: T[]; meta: { total: number; page: number; limit: number } }

export const api = {
  setupStatus: () => request<{ required: boolean }>("/auth/setup"),
  setup: (name: string, email: string, password: string) =>
    request<{ token: string; user: Identity }>("/auth/setup", { body: { name, email, password } }),
  login: (email: string, password: string) =>
    request<{ token: string; user: Identity }>("/auth/login", { body: { email, password } }),
  me: () => request<Identity>("/auth/me"),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("/auth/password", { method: "POST", body: { currentPassword, newPassword } }),

  stats: () => request<Wrapped<Stats>>("/stats").then(r => r.data),
  audit: (query: Record<string, string | number | undefined> = {}) => request<Paged<AuditEvent>>("/audit", { query }),
  search: (q: string) =>
    request<{
      data: {
        entries: {
          id: string
          slug: string
          title: string
          status: string
          updatedAt: string
          type: { name: string; label: string }
        }[]
        media: { id: string; filename: string; url: string; mime: string }[]
      }
    }>("/search", { query: { q } }).then(r => r.data),

  types: () => request<Wrapped<ContentType[]>>("/types").then(r => r.data),
  type: (name: string) => request<ContentType>(`/types/${name}`),
  createType: (input: Partial<ContentType>) => request<ContentType>("/types", { body: input }),
  updateType: (name: string, input: Partial<ContentType>) =>
    request<ContentType>(`/types/${name}`, { method: "PUT", body: input }),
  deleteType: (name: string) => request<{ deleted: boolean }>(`/types/${name}`, { method: "DELETE" }),

  entries: (type: string, query: Record<string, string | number | undefined> = {}) =>
    request<Paged<Entry>>(`/types/${type}/entries`, { query }),
  entry: (id: string) => request<Entry>(`/entries/${id}`),
  createEntry: (type: string, input: Partial<Entry>) => request<Entry>(`/types/${type}/entries`, { body: input }),
  updateEntry: (id: string, input: Partial<Entry>) => request<Entry>(`/entries/${id}`, { method: "PUT", body: input }),
  publishEntry: (id: string, at?: string) =>
    request<Entry>(`/entries/${id}/publish`, { method: "POST", query: { at } }),
  unpublishEntry: (id: string) => request<Entry>(`/entries/${id}/unpublish`, { method: "POST" }),
  setEntryStatus: (id: string, status: "draft" | "review" | "archived") =>
    request<Entry>(`/entries/${id}/status`, { method: "POST", body: { status } }),
  deleteEntry: (id: string) => request<{ deleted: boolean }>(`/entries/${id}`, { method: "DELETE" }),
  trashEntries: () => request<Wrapped<Entry[]>>("/trash/entries").then(result => result.data),
  restoreEntry: (id: string) => request<Entry>(`/trash/entries/${id}/restore`, { method: "POST" }),
  purgeEntry: (id: string) => request<{ purged: boolean }>(`/trash/entries/${id}`, { method: "DELETE" }),
  revisions: (id: string) =>
    request<
      Wrapped<
        {
          id: string
          title: string
          status: string
          authorName: string | null
          note: string | null
          createdAt: string
        }[]
      >
    >(`/entries/${id}/revisions`).then(r => r.data),
  revision: (id: string) =>
    request<{
      id: string
      entryId: string
      title: string
      data: Record<string, unknown>
      status: string
      createdAt: string
    }>(`/revisions/${id}`),
  restoreRevision: (id: string) => request<Entry>(`/revisions/${id}/restore`, { method: "POST" }),

  media: (query: Record<string, string | number | undefined> = {}) => request<Paged<Media>>("/media", { query }),
  mediaItem: (id: string) => request<Media>(`/media/${id}`),
  uploadMedia: (file: File, extra: Record<string, string> = {}) => {
    const form = new FormData()
    form.set("file", file)
    for (const [key, value] of Object.entries(extra)) form.set(key, value)
    return request<Media>("/media", { form })
  },
  updateMedia: (id: string, input: Partial<Media>) => request<Media>(`/media/${id}`, { method: "PUT", body: input }),
  deleteMedia: (id: string) => request<{ deleted: boolean }>(`/media/${id}`, { method: "DELETE" }),
  trashMedia: () => request<Wrapped<Media[]>>("/trash/media").then(result => result.data),
  restoreMedia: (id: string) => request<Media>(`/trash/media/${id}/restore`, { method: "POST" }),
  purgeMedia: (id: string) => request<{ purged: boolean }>(`/trash/media/${id}`, { method: "DELETE" }),

  settings: () =>
    request<{ data: Record<string, unknown>; schema: { key: string; label: string; type: string }[] }>("/settings"),
  saveSettings: (input: Record<string, unknown>) =>
    request<Wrapped<Record<string, unknown>>>("/settings", { method: "PUT", body: input }),

  plugins: () => request<Wrapped<Plugin[]>>("/plugins").then(r => r.data),
  plugin: (name: string) => request<Plugin>(`/plugins/${name}`),
  enablePlugin: (name: string) => request<{ enabled: string[] }>(`/plugins/${name}/enable`, { method: "POST" }),
  disablePlugin: (name: string) => request<Wrapped<Plugin>>(`/plugins/${name}/disable`, { method: "POST" }),
  savePluginSettings: (name: string, input: Record<string, unknown>) =>
    request<Wrapped<Record<string, unknown>>>(`/plugins/${name}/settings`, { method: "PUT", body: input }),
  pluginTable: (endpoint: string) => request<{ data: Record<string, unknown>[] }>(endpoint).then(r => r.data),
  pluginStats: (endpoint: string, days?: number) =>
    request<Wrapped<PluginStatsPayload>>(endpoint, { query: { days } }).then(r => r.data),
  pluginConnections: (endpoint: string) => request<Wrapped<PluginConnectionsPayload>>(endpoint).then(r => r.data),
  // Returns the consent URL rather than following it: a redirect to a third
  // party would be followed by this fetch, not by the address bar.
  pluginConnect: (endpoint: string, id: string) =>
    request<Wrapped<{ url: string }>>(`${endpoint}/${encodeURIComponent(id)}/start`, { method: "POST" }).then(
      r => r.data,
    ),
  pluginDisconnect: (endpoint: string, id: string) =>
    request<Wrapped<{ id: string }>>(`${endpoint}/${encodeURIComponent(id)}`, { method: "DELETE" }),

  keys: () =>
    request<
      Wrapped<
        {
          id: string
          name: string
          prefix: string
          scopes: string[]
          createdAt: string
          lastUsedAt: string | null
          expiresAt: string | null
          revokedAt: string | null
        }[]
      >
    >("/keys").then(r => r.data),
  createKey: (name: string, scopes: string[], expiresAt?: string) =>
    request<{ id: string; key: string; prefix: string }>("/keys", { body: { name, scopes, expiresAt } }),
  revokeKey: (id: string) => request<{ revoked: boolean }>(`/keys/${id}`, { method: "DELETE" }),

  agentKeys: () =>
    request<{
      data: AgentKey[]
      grantable: { scope: string; label: string }[]
      maxDays: number
    }>("/agents"),
  // The password is asked for again on purpose — see src/agents. It is sent,
  // never stored, and the plaintext key comes back exactly once.
  createAgentKey: (input: { name: string; password: string; grants: string[]; expiresAt?: string }) =>
    request<AgentKey & { key: string }>("/agents", { body: input }),
  revokeAgentKey: (id: string) => request<{ revoked: boolean }>(`/agents/${id}`, { method: "DELETE" }),

  users: () => request<{ data: Identity[]; roles: FieldOption[] }>("/users", { query: { limit: 200 } }),
  createUser: (input: { email: string; name: string; password: string; role: string }) =>
    request<Identity>("/users", { body: input }),
  updateUser: (id: string, input: Record<string, unknown>) =>
    request<Identity>(`/users/${id}`, { method: "PUT", body: input }),
  deleteUser: (id: string) => request<{ deleted: boolean }>(`/users/${id}`, { method: "DELETE" }),

  taxonomies: () => request<Wrapped<Taxonomy[]>>("/taxonomies").then(r => r.data),
  createTaxonomy: (input: { label: string; hierarchical: boolean }) =>
    request<Taxonomy>("/taxonomies", { body: input }),
  deleteTaxonomy: (name: string) => request<{ deleted: boolean }>(`/taxonomies/${name}`, { method: "DELETE" }),
  terms: (name: string) => request<Wrapped<Term[]>>(`/taxonomies/${name}/terms`).then(r => r.data),
  createTerm: (name: string, input: { label: string; slug?: string; parentId?: string; description?: string }) =>
    request<Term>(`/taxonomies/${name}/terms`, { body: input }),
  updateTerm: (id: string, input: Partial<Term>) => request<Term>(`/terms/${id}`, { method: "PUT", body: input }),
  deleteTerm: (id: string) => request<{ deleted: boolean }>(`/terms/${id}`, { method: "DELETE" }),
  entryTerms: (id: string) =>
    request<Wrapped<{ id: string; label: string; taxonomyId: string }[]>>(`/entries/${id}/terms`).then(r => r.data),
  setEntryTerms: (id: string, termIds: string[]) =>
    request<{ termIds: string[] }>(`/entries/${id}/terms`, { method: "PUT", body: { termIds } }),

  menus: () => request<Wrapped<Menu[]>>("/menus").then(r => r.data),
  saveMenu: (name: string, label: string, items: MenuItem[]) =>
    request<Menu>(`/menus/${name}`, { method: "PUT", body: { label, items } }),
  createMenu: (label: string) => request<Menu>("/menus", { body: { label, items: [] } }),
  deleteMenu: (name: string) => request<{ deleted: boolean }>(`/menus/${name}`, { method: "DELETE" }),

  aiProviders: () => request<{ data: AiProvider[]; redirectUri: string }>("/ai/providers"),
  aiCredentials: () => request<Wrapped<AiCredential[]>>("/ai/credentials").then(r => r.data),
  connectAiKey: (input: { provider: string; key?: string; model?: string; baseUrl?: string; label?: string }) =>
    request<AiCredential>("/ai/credentials", { body: input }),
  updateAiCredential: (id: string, input: Record<string, unknown>) =>
    request<AiCredential>(`/ai/credentials/${id}`, { method: "PUT", body: input }),
  deleteAiCredential: (id: string) => request<{ deleted: boolean }>(`/ai/credentials/${id}`, { method: "DELETE" }),
  testAiCredential: (id: string) =>
    request<{ ok: boolean; provider: string; model: string; refused?: boolean; error?: string }>(
      `/ai/credentials/${id}/test`,
      { method: "POST" },
    ),
  startAiOauth: (provider: string) =>
    request<{ url: string; expiresAt: string }>(`/ai/oauth/${provider}/start`, { method: "POST" }),

  agentStatus: () =>
    request<
      Wrapped<{
        configured: boolean
        supported: boolean
        provider: string | null
        model: string | null
        mayUse: boolean
        mayApply: boolean
      }>
    >("/ai/agent/status", { method: "POST" }).then(r => r.data),

  socialOverview: () => request<Wrapped<SocialOverview>>("/social/overview").then(r => r.data),
  socialNetworks: () =>
    request<Wrapped<{ redirectUri: string; networks: SocialNetwork[] }>>("/social/networks").then(r => r.data),
  socialPosts: (query: Record<string, string | number | undefined> = {}) =>
    request<Paged<SocialPost>>("/social/posts", { query }),
  socialPost: (id: string) => request<SocialPost>(`/social/posts/${id}`),
  createSocialPost: (input: SocialPostInput) => request<SocialPost>("/social/posts", { body: input }),
  updateSocialPost: (id: string, input: SocialPostInput) =>
    request<SocialPost>(`/social/posts/${id}`, { method: "PUT", body: input }),
  deleteSocialPost: (id: string) => request<{ deleted: boolean }>(`/social/posts/${id}`, { method: "DELETE" }),
  scheduleSocialPost: (id: string, at: string) =>
    request<SocialPost>(`/social/posts/${id}/schedule`, { method: "POST", body: { at } }),
  // Also the retry: the server skips every target that already posted, so
  // pressing this twice does not post twice.
  publishSocialPost: (id: string) =>
    request<{ data: SocialOutcome; post: SocialPost }>(`/social/posts/${id}/publish`, { method: "POST" }),
  cancelSocialPost: (id: string) => request<SocialPost>(`/social/posts/${id}/cancel`, { method: "POST" }),
  socialCalendar: (from: string, days: number) =>
    request<Wrapped<SocialPost[]>>("/social/calendar", { query: { from, days } }).then(r => r.data),
  socialAccounts: () =>
    request<
      Wrapped<{
        redirectUri: string
        networks: { value: string; label: string; help: string; scopes: string[]; configured: boolean }[]
        accounts: SocialAccount[]
      }>
    >("/social/accounts").then(r => r.data),
  socialSettings: () =>
    request<Wrapped<{ redirectUri: string; publicUrl: string; preamble: string; networks: SocialSetting[] }>>(
      "/social/settings",
    ).then(r => r.data),
  saveSocialApp: (network: string, input: SocialAppInput) =>
    request<Wrapped<SocialApp>>(`/social/settings/${network}`, { method: "PUT", body: input }).then(r => r.data),
  forgetSocialApp: (network: string) =>
    request<Wrapped<SocialApp>>(`/social/settings/${network}`, { method: "DELETE" }).then(r => r.data),

  connectSocial: (network: string) =>
    request<Wrapped<{ url: string; expiresAt: string }>>(`/social/accounts/${network}/start`, { method: "POST" }).then(
      r => r.data,
    ),
  disconnectSocial: (id: string) => request<Wrapped<{ id: string }>>(`/social/accounts/${id}`, { method: "DELETE" }),

  webhooks: () => request<{ data: Webhook[]; events: string[] }>("/webhooks"),
  createWebhook: (input: { name: string; url: string; events: string[]; active: boolean }) =>
    request<Webhook & { secret: string }>("/webhooks", { body: input }),
  updateWebhook: (id: string, input: Partial<Webhook>) =>
    request<Webhook>(`/webhooks/${id}`, { method: "PUT", body: input }),
  deleteWebhook: (id: string) => request<{ deleted: boolean }>(`/webhooks/${id}`, { method: "DELETE" }),
  testWebhook: (id: string) =>
    request<{ delivered: boolean; status: number }>(`/webhooks/${id}/test`, { method: "POST" }),
}
