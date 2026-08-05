import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn, PipeFn, Route } from "@atlas/server"
import { badRequest, del, get, json, notFound, parseJson, pipe, pipeline, post, put, unauthorized } from "@atlas/server"
import { auth, requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { config } from "../config/index.ts"
import { body, optionalText, requireText } from "../http/index.ts"
import { id, secretToken, sha256 } from "../ids/index.ts"
import { decodeArray, encode } from "../json/index.ts"
import { apiKeys, contentTypes } from "../schema/index.ts"
import { now, parseIso } from "../time/index.ts"

const PREFIX = "ink"

export type ApiKeyRow = {
  id: string
  name: string
  hashed_key: string
  prefix: string
  scopes: string
  created_by: string | null
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
}

// An empty scope list means "every type"; a non-empty one must name types that
// actually exist, or a typo would silently narrow a key to nothing.
const parseScopes = async (db: Connection, raw: unknown): Promise<string[]> => {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some(s => typeof s !== "string")) {
    throw badRequest("scopes must be an array of content type names", { code: "BAD_SCOPES" })
  }
  const scopes = [...new Set(raw as string[])]
  if (scopes.length === 0) return scopes

  const found = await db.all<{ name: string }>(
    from(contentTypes)
      .select("name")
      .where(q => q("name").inList(scopes)),
  )
  if (found.length !== scopes.length) {
    const missing = scopes.filter(scope => !found.some(row => row.name === scope))
    throw badRequest(`These content types do not exist: ${missing.join(", ")}`, { code: "BAD_SCOPES" })
  }
  return scopes
}

const present = (row: ApiKeyRow) => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  scopes: decodeArray<string>(row.scopes),
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
})

export type KeyIdentity = { readonly id: string; readonly name: string; readonly scopes: readonly string[] }

// Guards the delivery API. Keys are stored only as SHA-256, so verification is
// a hash-and-lookup — there is no way to recover a key from the database.
export const requireApiKey = (db: Connection): PipeFn =>
  pipe(async (c: Conn) => {
    const header = c.headers.get("x-api-key") ?? ""
    const authorization = c.headers.get("authorization") ?? ""
    const supplied = header || (authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "")
    if (!supplied) throw unauthorized("An API key is required", { code: "NO_KEY" })

    const hashed = await sha256(supplied)
    const row = await db.one<ApiKeyRow>(from(apiKeys).where(q => q("hashed_key").equals(hashed)))
    if (!row || row.revoked_at !== null) throw unauthorized("API key is not valid", { code: "BAD_KEY" })
    if (row.expires_at !== null && row.expires_at <= now())
      throw unauthorized("API key has expired", { code: "EXPIRED_KEY" })

    void db
      .execute(
        from(apiKeys)
          .update({ last_used_at: now() })
          .where(q => q("id").equals(row.id)),
      )
      .catch(() => {})

    const identity: KeyIdentity = { id: row.id, name: row.name, scopes: decodeArray<string>(row.scopes) }
    return { ...c, assigns: { ...c.assigns, apiKey: identity } }
  })

export const keyIdentity = (c: Conn): KeyIdentity => c.assigns.apiKey as KeyIdentity

// An empty scope list means "every content type" — the common single-site case.
export const keyAllows = (identity: KeyIdentity, typeName: string): boolean =>
  identity.scopes.length === 0 || identity.scopes.includes(typeName)

// Keys are stored only as a SHA-256, so a consumer that needs the same key on
// every boot cannot read the last one back. Deriving it from SECRET solves that
// without storing the secret anywhere: the same instance computes the same key
// forever, and the row is only ever created, never replaced.
//
// Minting a fresh random one per boot was the obvious first answer and is
// wrong — a second process starting up would replace the row and silently
// invalidate the key the first one was still holding.
//
// This exposes nothing new: anyone holding SECRET can already forge a session,
// which outranks a read-only key to published content.
const derivedKey = async (secret: string, name: string): Promise<string> => {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign("HMAC", material, new TextEncoder().encode(`delivery-key:${name}`))
  const body = btoa(String.fromCharCode(...new Uint8Array(mac)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return `${PREFIX}_${body}`
}

// A delivery key for a consumer running inside this process.
//
// Scopes are left empty on purpose: an in-process site reads whatever content
// model it installs, and a scoped key would start 403ing the moment a new type
// was added.
export const ensureNamedKey = async (db: Connection, name: string): Promise<string> => {
  const plaintext = await derivedKey(config.secret, name)
  const hashed = await sha256(plaintext)

  const existing = await db.one<ApiKeyRow>(from(apiKeys).where(q => q("hashed_key").equals(hashed)))
  if (existing && existing.revoked_at === null) return plaintext

  // Either nothing is stored yet, or what is stored is stale — a key from
  // before SECRET changed, or one an operator revoked. Both want replacing, and
  // matching on the name keeps exactly one of these in the admin's key list.
  await db.execute(
    from(apiKeys)
      .del()
      .where(q => q("name").equals(name)),
  )

  await db.execute(
    from(apiKeys).insert({
      id: id(),
      name,
      hashed_key: hashed,
      prefix: plaintext.slice(0, PREFIX.length + 9),
      scopes: encode([]),
      created_by: null,
      created_at: now(),
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    } satisfies ApiKeyRow),
  )

  return plaintext
}

export const apiKeyRoutes = (db: Connection): Route[] => {
  const read = pipeline(requireAuth(db), requireCan(can.manageKeys, "manage API keys"))
  const write = pipeline(requireAuth(db), requireCan(can.manageKeys, "manage API keys"), parseJson)

  return [
    get(
      "/keys",
      read(async c => {
        const rows = await db.all<ApiKeyRow>(from(apiKeys).orderBy("created_at", "DESC"))
        return json(c, 200, { data: rows.map(present) })
      }),
    ),

    post(
      "/keys",
      write(async c => {
        const input = body(c)
        const name = requireText(input, "name", "Name")

        const scopes = await parseScopes(db, input.scopes)

        const requestedExpiry = optionalText(input, "expiresAt")
        const expiresAt = parseIso(requestedExpiry)
        if (requestedExpiry && !expiresAt) throw badRequest("Expiration time is invalid", { code: "BAD_EXPIRY" })
        if (expiresAt && expiresAt <= now()) {
          throw badRequest("Expiration time must be in the future", { code: "BAD_EXPIRY" })
        }
        const plaintext = secretToken(PREFIX)

        const row: ApiKeyRow = {
          id: id(),
          name,
          hashed_key: await sha256(plaintext),
          // Enough to recognize the key in a list, far too little to rebuild it.
          prefix: plaintext.slice(0, PREFIX.length + 9),
          scopes: encode(scopes),
          created_by: auth(c).id,
          created_at: now(),
          last_used_at: null,
          expires_at: expiresAt,
          revoked_at: null,
        }

        await db.execute(from(apiKeys).insert(row))

        // The only time the plaintext is ever returned.
        return json(c, 201, { ...present(row), key: plaintext })
      }),
    ),

    // The content model grows after a key is minted, and a scoped key that
    // cannot be widened would have to be replaced across every consumer. The
    // secret itself stays untouchable — only its name and reach change.
    put(
      "/keys/:id",
      write(async c => {
        const row = await db.one<ApiKeyRow>(from(apiKeys).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("API key not found")
        if (row.revoked_at) throw badRequest("That key has been revoked", { code: "REVOKED" })

        const input = body(c)
        const changes: Record<string, unknown> = {}
        if (input.name !== undefined) changes.name = requireText(input, "name", "Name")
        if (input.scopes !== undefined) changes.scopes = encode(await parseScopes(db, input.scopes))
        if (Object.keys(changes).length === 0) return json(c, 200, present(row))

        await db.execute(
          from(apiKeys)
            .update(changes)
            .where(q => q("id").equals(row.id)),
        )
        const updated = await db.one<ApiKeyRow>(from(apiKeys).where(q => q("id").equals(row.id)))
        return json(c, 200, present(updated as ApiKeyRow))
      }),
    ),

    del(
      "/keys/:id",
      read(async c => {
        const row = await db.one<ApiKeyRow>(from(apiKeys).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("API key not found")

        await db.execute(
          from(apiKeys)
            .update({ revoked_at: now() })
            .where(q => q("id").equals(row.id)),
        )
        return json(c, 200, { revoked: true, id: row.id })
      }),
    ),
  ]
}
