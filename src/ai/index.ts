import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Route } from "@atlas/server"
import { badRequest, conflict, del, get, json, notFound, parseJson, pipeline, post, put } from "@atlas/server"
import { auth, requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { body, optionalText, requireText } from "../http/index.ts"
import { id } from "../ids/index.ts"
import { aiCredentials } from "../schema/index.ts"
import { now } from "../time/index.ts"
import type { ResolvedCredential } from "./complete.ts"
import { complete } from "./complete.ts"
import type { ProviderName } from "./providers.ts"
import { isProvider, PROVIDERS, providerCatalog } from "./providers.ts"
import { open, seal } from "./secrets.ts"

export type AiCredentialRow = {
  id: string
  provider: string
  label: string
  model: string
  base_url: string | null
  ciphertext: string
  iv: string
  hint: string
  is_default: number
  created_by: string | null
  created_at: string
  updated_at: string
  last_used_at: string | null
  revoked_at: string | null
}

// `ciphertext` and `iv` are structurally absent here rather than deleted from a
// spread, so a future field can't be added to the row type and leak by default.
const present = (row: AiCredentialRow) => ({
  id: row.id,
  provider: row.provider,
  label: row.label,
  model: row.model,
  baseUrl: row.base_url,
  hint: row.hint,
  isDefault: row.is_default === 1,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
})

// A query, not a call against a connection — the builder is standalone and the
// caller decides which connection runs it.
const activeCredentials = () =>
  from(aiCredentials)
    .where(q => q("revoked_at").isNull())
    .orderBy("is_default", "DESC")
    .orderBy("created_at", "ASC")

// The credential the assistant should use: the explicit default if one is set,
// otherwise the oldest surviving connection. Returns null when nothing is
// configured, which every caller treats as "the assistant is off" rather than as
// an error — a fresh install has no provider and that is a normal state.
export const resolveCredential = async (db: Connection): Promise<ResolvedCredential | null> => {
  const row = await db.one<AiCredentialRow>(activeCredentials())
  if (!row || !isProvider(row.provider)) return null

  const spec = PROVIDERS[row.provider]
  const secret = spec.needsKey ? await open(row) : ""
  // A rotated SECRET leaves ciphertext that no longer opens. Treating that as
  // "not configured" surfaces in the UI as a provider to reconnect.
  if (spec.needsKey && secret === null) return null

  void db
    .execute(
      from(aiCredentials)
        .update({ last_used_at: now() })
        .where(q => q("id").equals(row.id)),
    )
    .catch(() => {})

  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    secret: secret ?? "",
    baseUrl: row.base_url,
  }
}

export const aiEnabled = async (db: Connection): Promise<boolean> => (await resolveCredential(db)) !== null

export const aiRoutes = (db: Connection): Route[] => {
  const read = pipeline(requireAuth(db), requireCan(can.manageAi, "manage AI providers"))
  const write = pipeline(requireAuth(db), requireCan(can.manageAi, "manage AI providers"), parseJson)
  const act = pipeline(requireAuth(db), requireCan(can.manageAi, "manage AI providers"))

  const parseModel = (provider: ProviderName, raw: unknown): string => {
    const spec = PROVIDERS[provider]
    const model = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : spec.defaultModel
    // Not restricted to the catalog: providers ship models faster than this list
    // is updated, and an operator naming a newer one shouldn't have to wait for a
    // release. Length is bounded so it can't become a dumping ground.
    if (model.length > 96) throw badRequest("Model name is too long", { code: "BAD_MODEL" })
    return model
  }

  const parseBaseUrl = (provider: ProviderName, raw: unknown): string | null => {
    const spec = PROVIDERS[provider]
    const value = typeof raw === "string" ? raw.trim() : ""
    if (!value) {
      if (spec.needsBaseUrl) throw badRequest(`${spec.label} needs a base URL`, { code: "BAD_BASE_URL" })
      return null
    }
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme")
      return parsed.toString().replace(/\/$/, "")
    } catch {
      throw badRequest("Base URL must be an absolute http(s) URL", { code: "BAD_BASE_URL" })
    }
  }

  // Exactly one default. Done as a separate statement inside the caller's
  // transaction rather than a partial unique index, which isn't portable.
  const clearDefaults = async (tx: Connection, exceptId: string) =>
    tx.execute(
      from(aiCredentials)
        .update({ is_default: 0 })
        .where(q => q("id").notEquals(exceptId)),
    )

  return [
    get(
      "/ai/providers",
      read(async c => json(c, 200, { data: providerCatalog() })),
    ),

    get(
      "/ai/credentials",
      read(async c => {
        const rows = await db.all<AiCredentialRow>(from(aiCredentials).orderBy("created_at", "DESC"))
        return json(c, 200, { data: rows.map(present) })
      }),
    ),

    post(
      "/ai/credentials",
      write(async c => {
        const input = body(c)
        const providerName = requireText(input, "provider", "Provider")
        if (!isProvider(providerName)) throw badRequest("Unknown provider", { code: "BAD_PROVIDER" })
        const spec = PROVIDERS[providerName]

        const label = optionalText(input, "label") ?? spec.label
        const model = parseModel(providerName, input.model)
        const baseUrl = parseBaseUrl(providerName, input.baseUrl)

        const secret = spec.needsKey ? requireText(input, "key", `${spec.label} API key`) : ""
        if (spec.needsKey && secret.length < 8) throw badRequest("That key looks too short", { code: "BAD_KEY" })

        const sealed = await seal(secret)
        const timestamp = now()
        const row: AiCredentialRow = {
          id: id(),
          provider: providerName,
          label,
          model,
          base_url: baseUrl,
          ciphertext: sealed.ciphertext,
          iv: sealed.iv,
          hint: sealed.hint,
          is_default: 1,
          created_by: auth(c).id,
          created_at: timestamp,
          updated_at: timestamp,
          last_used_at: null,
          revoked_at: null,
        }

        // Newest connection becomes the default — an operator adding a provider
        // is expressing a preference, not archiving one.
        await db.transaction(async tx => {
          await tx.execute(from(aiCredentials).insert(row))
          await clearDefaults(tx, row.id)
        })

        return json(c, 201, present(row))
      }),
    ),

    put(
      "/ai/credentials/:id",
      write(async c => {
        const row = await db.one<AiCredentialRow>(from(aiCredentials).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("Provider connection not found")
        if (row.revoked_at) throw badRequest("That connection has been removed", { code: "REVOKED" })
        if (!isProvider(row.provider)) throw badRequest("Unknown provider", { code: "BAD_PROVIDER" })

        const input = body(c)
        const changes: Record<string, unknown> = { updated_at: now() }
        if (input.label !== undefined) changes.label = requireText(input, "label", "Label")
        if (input.model !== undefined) changes.model = parseModel(row.provider, input.model)
        if (input.baseUrl !== undefined) changes.base_url = parseBaseUrl(row.provider, input.baseUrl)

        // Replacing the key is an update; reading it back never is.
        if (input.key !== undefined) {
          const secret = requireText(input, "key", "API key")
          const sealed = await seal(secret)
          changes.ciphertext = sealed.ciphertext
          changes.iv = sealed.iv
          changes.hint = sealed.hint
        }

        const makeDefault = input.isDefault === true

        await db.transaction(async tx => {
          await tx.execute(
            from(aiCredentials)
              .update(makeDefault ? { ...changes, is_default: 1 } : changes)
              .where(q => q("id").equals(row.id)),
          )
          if (makeDefault) await clearDefaults(tx, row.id)
        })

        const updated = await db.one<AiCredentialRow>(from(aiCredentials).where(q => q("id").equals(row.id)))
        return json(c, 200, present(updated as AiCredentialRow))
      }),
    ),

    del(
      "/ai/credentials/:id",
      act(async c => {
        const row = await db.one<AiCredentialRow>(from(aiCredentials).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("Provider connection not found")

        // Hard delete rather than a soft one: the row's only real content is a
        // secret, and keeping ciphertext around after an operator asked for it to
        // be gone is the wrong default.
        await db.execute(
          from(aiCredentials)
            .where(q => q("id").equals(row.id))
            .del(),
        )

        // Promote whatever is left so the assistant keeps working.
        const next = await db.one<AiCredentialRow>(activeCredentials())
        if (next) {
          await db.execute(
            from(aiCredentials)
              .update({ is_default: 1 })
              .where(q => q("id").equals(next.id)),
          )
        }

        return json(c, 200, { deleted: true, id: row.id })
      }),
    ),

    // Round-trips one cheap request so an operator finds out the key is wrong
    // here, rather than the first time an author asks for a draft.
    post(
      "/ai/credentials/:id/test",
      act(async c => {
        const row = await db.one<AiCredentialRow>(from(aiCredentials).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("Provider connection not found")
        if (!isProvider(row.provider)) throw badRequest("Unknown provider", { code: "BAD_PROVIDER" })

        const spec = PROVIDERS[row.provider]
        const secret = spec.needsKey ? await open(row) : ""
        if (spec.needsKey && secret === null) {
          throw conflict("This connection can no longer be decrypted — re-enter its key", { code: "SEALED" })
        }

        const credential: ResolvedCredential = {
          id: row.id,
          provider: row.provider,
          model: row.model,
          secret: secret ?? "",
          baseUrl: row.base_url,
        }

        try {
          const result = await complete(credential, {
            system: "Reply with the single word OK.",
            prompt: "Reply with the single word OK.",
            maxTokens: 16,
          })
          return json(c, 200, {
            ok: !result.refused && result.text.trim() !== "",
            provider: result.provider,
            model: result.model,
            refused: result.refused,
          })
        } catch (error) {
          // The provider's message is the useful part (bad key, no quota, host
          // unreachable) and contains no secret, so it is passed through.
          return json(c, 200, { ok: false, provider: row.provider, model: row.model, error: (error as Error).message })
        }
      }),
    ),
  ]
}

export type { Completion, CompletionRequest, ResolvedCredential } from "./complete.ts"
export { complete, completeStream } from "./complete.ts"
