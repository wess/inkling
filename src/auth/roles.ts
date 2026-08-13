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

// Capability checks the route layer reads, so permission rules live in one
// place rather than as scattered role-string comparisons.
export const can = {
  readContent: (role: string) => atLeast(role, "viewer"),
  writeContent: (role: string) => atLeast(role, "author"),
  publishContent: (role: string) => atLeast(role, "editor"),
  deleteAnyContent: (role: string) => atLeast(role, "editor"),
  manageMedia: (role: string) => atLeast(role, "author"),
  manageTypes: (role: string) => atLeast(role, "admin"),
  manageTaxonomy: (role: string) => atLeast(role, "editor"),
  manageMenus: (role: string) => atLeast(role, "editor"),
  manageSettings: (role: string) => atLeast(role, "admin"),
  manageKeys: (role: string) => atLeast(role, "admin"),
  manageWebhooks: (role: string) => atLeast(role, "admin"),
  managePlugins: (role: string) => atLeast(role, "admin"),
  manageUsers: (role: string) => atLeast(role, "admin"),
  manageOwners: (role: string) => atLeast(role, "owner"),
  // Connecting a provider means spending the operator's money, so it sits with
  // the other administrative settings. *Using* the assistant only needs
  // writeContent — an author drafting a post is the point of it.
  manageAi: (role: string) => atLeast(role, "admin"),
  useAi: (role: string) => atLeast(role, "author"),
  // Social splits three ways rather than two, because sending is irreversible
  // in a way publishing an entry is not — an entry can be unpublished, a tweet
  // has been read. Writing a post is authoring; sending one is publishing; and
  // connecting an account hands this install the right to speak as a brand,
  // which sits with the other administrative acts.
  writeSocial: (role: string) => atLeast(role, "author"),
  publishSocial: (role: string) => atLeast(role, "editor"),
  manageSocial: (role: string) => atLeast(role, "admin"),
}
