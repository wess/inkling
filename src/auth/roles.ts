// Roles are a strict ladder — every capability of a lower role is held by the
// higher ones. Anything finer-grained than this belongs to a plugin.

export const ROLES = ["viewer", "author", "editor", "admin", "owner"] as const

export type Role = (typeof ROLES)[number]

const RANK: Record<Role, number> = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 }

export const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value)

export const rank = (role: string): number => (isRole(role) ? RANK[role] : -1)

export const atLeast = (role: string, minimum: Role): boolean => rank(role) >= RANK[minimum]

export const ROLE_LABELS: Record<Role, string> = {
  viewer: "Viewer — read-only",
  author: "Author — write and submit own entries",
  editor: "Editor — write and publish any entry",
  admin: "Admin — manage content types, media, users, plugins",
  owner: "Owner — everything, including other owners",
}

// Every capability carries a name, and the names are the vocabulary an agent
// key's grants are written in. That is the whole reason they exist: a machine
// credential has to be narrower than the account behind it, and "narrower" is
// only checkable if the route layer and the grant list are talking about the
// same things. `requireCan` reads `.scope` off the predicate it is handed, so
// route code is unchanged and cannot forget.
export const SCOPES = [
  "content.read",
  "content.write",
  "content.publish",
  "content.delete",
  "media.manage",
  "types.manage",
  "taxonomy.manage",
  "menus.manage",
  "settings.manage",
  "keys.manage",
  "webhooks.manage",
  "plugins.manage",
  "users.manage",
  "owners.manage",
  "ai.manage",
  "ai.use",
  "social.write",
  "social.publish",
  "social.manage",
] as const

export type Scope = (typeof SCOPES)[number]

export const isScope = (value: string): value is Scope => (SCOPES as readonly string[]).includes(value)

export type Capability = ((role: string) => boolean) & { readonly scope: Scope }

const capability = (scope: Scope, minimum: Role): Capability =>
  Object.assign((role: string) => atLeast(role, minimum), { scope })

// Capability checks the route layer reads, so permission rules live in one
// place rather than as scattered role-string comparisons.
export const can = {
  readContent: capability("content.read", "viewer"),
  writeContent: capability("content.write", "author"),
  publishContent: capability("content.publish", "editor"),
  deleteAnyContent: capability("content.delete", "editor"),
  manageMedia: capability("media.manage", "author"),
  manageTypes: capability("types.manage", "admin"),
  manageTaxonomy: capability("taxonomy.manage", "editor"),
  manageMenus: capability("menus.manage", "editor"),
  manageSettings: capability("settings.manage", "admin"),
  manageKeys: capability("keys.manage", "admin"),
  manageWebhooks: capability("webhooks.manage", "admin"),
  managePlugins: capability("plugins.manage", "admin"),
  manageUsers: capability("users.manage", "admin"),
  manageOwners: capability("owners.manage", "owner"),
  // Connecting a provider means spending the operator's money, so it sits with
  // the other administrative settings. *Using* the assistant only needs
  // writeContent — an author drafting a post is the point of it.
  manageAi: capability("ai.manage", "admin"),
  useAi: capability("ai.use", "author"),
  // Social splits three ways rather than two, because sending is irreversible
  // in a way publishing an entry is not — an entry can be unpublished, a tweet
  // has been read. Writing a post is authoring; sending one is publishing; and
  // connecting an account hands this install the right to speak as a brand,
  // which sits with the other administrative acts.
  writeSocial: capability("social.write", "author"),
  publishSocial: capability("social.publish", "editor"),
  manageSocial: capability("social.manage", "admin"),
}

// Which of those a role actually holds. The admin reads this to know whether a
// proposal's Apply button will be refused before anybody presses it — the panel
// cannot re-derive the ladder without keeping a second copy of it in the
// browser, and a second copy is how the two drift.
export const scopesFor = (role: string): Scope[] =>
  Object.values(can)
    .filter(capability => capability(role))
    .map(capability => capability.scope)

// What an agent key may ever be granted, however senior the account behind it.
//
// The line is drawn at anything that widens the blast radius beyond this
// install's content. Minting a delivery key, registering a webhook, enabling a
// plugin, replacing a provider credential, connecting a social account, or
// creating a user are each a way to turn one leaked machine token into standing
// access that outlives its revocation — and creating a user is a way to turn it
// into a second owner. None of that is work an agent should be doing
// unattended, so none of it is grantable and the escalation simply is not
// reachable from a token.
//
// `ai.use` is out for a different reason: the assistant spends the operator's
// money, and a machine credential looping through it is a bill rather than a
// breach. A person in the admin is who that feature is for.
const NOT_GRANTABLE: ReadonlySet<Scope> = new Set([
  "keys.manage",
  "webhooks.manage",
  "plugins.manage",
  "users.manage",
  "owners.manage",
  "ai.manage",
  "ai.use",
  "social.manage",
])

export const GRANTABLE_SCOPES: readonly Scope[] = SCOPES.filter(scope => !NOT_GRANTABLE.has(scope))

export const isGrantable = (value: string): value is Scope => isScope(value) && !NOT_GRANTABLE.has(value)

// What each grant means, in the words the person handing out the token would
// use. Shown next to the checkboxes in the admin.
export const SCOPE_LABELS: Record<Scope, string> = {
  "content.read": "Read entries, types, media, and settings",
  "content.write": "Create and edit entries",
  "content.publish": "Publish and unpublish entries",
  "content.delete": "Move entries to trash and purge them",
  "media.manage": "Upload and edit media",
  "types.manage": "Change the shape of content types",
  "taxonomy.manage": "Manage taxonomies and terms",
  "menus.manage": "Manage navigation menus",
  "settings.manage": "Change site title, logo, and other site details",
  "keys.manage": "Manage delivery API keys",
  "webhooks.manage": "Manage outbound webhooks",
  "plugins.manage": "Enable, disable, and configure plugins",
  "users.manage": "Manage user accounts",
  "owners.manage": "Manage owner accounts",
  "ai.manage": "Connect and configure AI providers",
  "ai.use": "Use the assistant and the agent",
  "social.write": "Compose social posts",
  "social.publish": "Send and schedule social posts",
  "social.manage": "Connect social accounts",
}
