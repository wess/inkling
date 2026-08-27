import type { Connection } from "atlas/db"
import { open, seal } from "../ai/secrets.ts"
import { readSetting, writeSetting } from "../settings/index.ts"
import type { PluginSetting } from "./define.ts"

// A plugin setting declared as `secret` is a credential, not a preference, and
// the two want opposite things. A preference is read back into the form it was
// typed in. A credential is written once and never shown again — so it is
// sealed at rest with the same key as every other stored secret, and everything
// that reads settings for a human or for a model gets four characters of it.
//
// This is the only file that knows that. The settings table stays a plain
// key/value store; the plugin reads plaintext from `getSetting` and does not
// know it was ever encrypted; the API and the assistant both write through
// `writePluginSettings`, so there is one place where a secret can be set and
// no path that stores one in the clear.

export const MASK = "••••"

type SealedSetting = { readonly ciphertext: string; readonly iv: string; readonly hint: string }

const isSealed = (value: unknown): value is SealedSetting =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as SealedSetting).ciphertext === "string" &&
  typeof (value as SealedSetting).iv === "string"

export const secretKeys = (declared: readonly PluginSetting[] = []): Set<string> =>
  new Set(declared.filter(setting => setting.type === "secret").map(setting => setting.key))

// For any screen, any API response, and anything an assistant reads: a secret
// becomes its hint, and an unset one becomes an empty string rather than null,
// so a form binds to it without a special case.
export const maskSecrets = (
  declared: readonly PluginSetting[] = [],
  values: Record<string, unknown>,
): Record<string, unknown> => {
  const secrets = secretKeys(declared)
  if (secrets.size === 0) return values

  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      if (!secrets.has(key)) return [key, value]
      return [key, isSealed(value) ? value.hint : ""]
    }),
  )
}

// For the plugin itself. A value that no longer opens — the usual cause is a
// rotated SECRET — reads as unset, which is what the guide will then say.
export const openSecrets = async (
  declared: readonly PluginSetting[] = [],
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const secrets = secretKeys(declared)
  if (secrets.size === 0) return values

  const entries = await Promise.all(
    Object.entries(values).map(async ([key, value]) => {
      if (!secrets.has(key) || !isSealed(value)) return [key, value] as const
      return [key, (await open(value)) ?? ""] as const
    }),
  )
  return Object.fromEntries(entries)
}

export const readPluginSetting = async <T>(
  db: Connection,
  plugin: { readonly name: string; readonly settings?: readonly PluginSetting[] },
  key: string,
  fallback: T,
): Promise<T> => {
  if (!secretKeys(plugin.settings).has(key)) return readSetting(db, plugin.name, key, fallback)

  const sealed = await readSetting<SealedSetting | null>(db, plugin.name, key, null)
  if (!isSealed(sealed)) return fallback
  return (((await open(sealed)) || null) as T | null) ?? fallback
}

// The one write path, and the only place that decides what an incoming secret
// means. Three cases, because a form that never echoes a secret back has to be
// able to say "leave it" and "remove it" without saying the value:
//
//   null            → clear it
//   "" or the mask  → leave what is stored alone
//   anything else   → seal it
//
// A non-secret setting is written as it arrives, exactly as before.
export const writePluginSettings = async (
  db: Connection,
  plugin: { readonly name: string; readonly settings?: readonly PluginSetting[] },
  patch: Record<string, unknown>,
): Promise<void> => {
  const secrets = secretKeys(plugin.settings)

  const writes: [string, unknown][] = []
  for (const [key, value] of Object.entries(patch)) {
    if (!secrets.has(key)) {
      writes.push([key, value])
      continue
    }
    if (value === null) {
      writes.push([key, null])
      continue
    }
    const text = typeof value === "string" ? value.trim() : ""
    if (text === "" || text.startsWith(MASK)) continue
    writes.push([key, await seal(text)])
  }

  if (writes.length === 0) return
  await db.transaction(async tx => {
    for (const [key, value] of writes) await writeSetting(tx, plugin.name, key, value)
  })
}
