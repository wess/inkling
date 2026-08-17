import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Scope } from "../auth/roles.ts"
import { isGrantable } from "../auth/roles.ts"
import { decodeArray } from "../json/index.ts"
import { agentKeys } from "../schema/index.ts"
import { now } from "../time/index.ts"

// Verification only, kept apart from the routes so `src/auth/guard.ts` can read
// it without importing the module that imports the guard.

export const AGENT_PREFIX = "inkagt"

export type AgentKeyRow = {
  id: string
  name: string
  hashed_key: string
  prefix: string
  grants: string
  user_id: string
  created_at: string
  last_used_at: string | null
  last_ip: string | null
  expires_at: string
  revoked_at: string | null
}

export const looksLikeAgentKey = (value: string): boolean => value.startsWith(`${AGENT_PREFIX}_`)

// A grant written by an older build — or by hand — could name a scope this
// version no longer honours, or one that has since been pulled out of the
// grantable set. Filtering on read means the ceiling in `roles.ts` is the live
// answer rather than whatever was true the day the key was minted.
export const grantsOf = (row: Pick<AgentKeyRow, "grants">): ReadonlySet<Scope> =>
  new Set(decodeArray<string>(row.grants).filter(isGrantable))

export const findAgentKey = async (db: Connection, hashed: string): Promise<AgentKeyRow | null> =>
  db.one<AgentKeyRow>(from(agentKeys).where(q => q("hashed_key").equals(hashed)))

export const touchAgentKey = (db: Connection, keyId: string, ip: string): void => {
  void db
    .execute(
      from(agentKeys)
        .update({ last_used_at: now(), last_ip: ip || null })
        .where(q => q("id").equals(keyId)),
    )
    .catch(() => {})
}
