import { config } from "../config/index.ts"

// Operator-supplied provider keys are encrypted at rest with AES-GCM, keyed off
// SECRET. That is a deliberately modest guarantee and worth stating plainly: it
// protects a database dump, a stray backup, and a read-only SQL leak — it does
// not protect against an attacker who already has the process environment,
// because the key is derived from it. The alternative (a separate KMS) would add
// an operational dependency that a self-hosted CMS shouldn't require to boot.
//
// SECRET is required to be >= 32 chars in production (see src/server.ts), so
// rotating it invalidates every stored credential. Sessions already behave that
// way, so the failure mode is one an operator has met before.

const keyFor = async (): Promise<CryptoKey> => {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(config.secret))
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"])
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

// Allocated rather than built with Uint8Array.from, so the result is backed by a
// plain ArrayBuffer — WebCrypto's BufferSource will not accept the
// possibly-shared buffer type the functional form infers.
const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export type Sealed = { readonly ciphertext: string; readonly iv: string; readonly hint: string }

// The hint is the tail rather than the head: provider keys carry a recognizable
// prefix (`sk-ant-`, `sk-`), so showing the front would identify the vendor and
// nothing else, while the last four characters are what an operator actually
// compares against their dashboard.
const hintOf = (secret: string): string => (secret.length <= 4 ? "••••" : `••••${secret.slice(-4)}`)

export const seal = async (secret: string): Promise<Sealed> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await keyFor(),
    new TextEncoder().encode(secret),
  )
  return { ciphertext: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv), hint: hintOf(secret) }
}

// Returns null rather than throwing when the ciphertext no longer opens — the
// usual cause is a rotated SECRET, and a credential that can't be decrypted
// should read as "reconnect this provider", not as a 500.
export const open = async (sealed: Pick<Sealed, "ciphertext" | "iv">): Promise<string | null> => {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(sealed.iv) },
      await keyFor(),
      fromBase64(sealed.ciphertext),
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    return null
  }
}
