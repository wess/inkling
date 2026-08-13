import { config } from "../config/index.ts"
import { createLocalDriver } from "./local/index.ts"
import { createS3Driver } from "./s3/index.ts"

// The only place blob backends are touched. Consumers import `put`, `get`,
// `drop`, and `makeKey` from here and never reach into a driver directly.
//
// `signedUrl` is deliberately absent from the interface: every read goes
// through the API so access rules stay enforceable in one place, and adding a
// presign method would quietly create a second, unguarded read path.

export type StorageDriver = {
  readonly kind: string
  readonly put: (key: string, body: Blob | Uint8Array | string, contentType: string) => Promise<{ url: string }>
  readonly get: (key: string) => Promise<ReadableStream | null>
  readonly drop: (key: string) => Promise<void>
}

export type StorageConfig =
  | { readonly driver: "local"; readonly dir: string }
  | {
      readonly driver: "s3"
      readonly endpoint: string
      readonly bucket: string
      readonly region: string
      readonly accessKey: string
      readonly secretKey: string
      readonly publicUrl: string
      readonly prefix: string
    }

export const createStorage = (settings: StorageConfig): StorageDriver => {
  switch (settings.driver) {
    case "s3":
      return createS3Driver(settings)
    case "local":
      return createLocalDriver(settings.dir)
    default: {
      const exhaustive: never = settings
      throw new Error(`Unknown storage driver: ${JSON.stringify(exhaustive)}`)
    }
  }
}

export const storageFromConfig = (): StorageDriver =>
  config.storage.driver === "s3"
    ? createStorage({
        driver: "s3",
        endpoint: config.storage.endpoint,
        bucket: config.storage.bucket,
        region: config.storage.region,
        accessKey: config.storage.accessKey,
        secretKey: config.storage.secretKey,
        publicUrl: config.storage.publicUrl,
        prefix: config.storage.prefix,
      })
    : createStorage({ driver: "local", dir: config.storage.localDir })

// Keys are `<yyyy>/<mm>/<random>/<sanitized name>` — dated so a bucket stays
// browsable, randomized so two uploads of "logo.png" never collide.
//
// The random segment is 8 bytes rendered as 16 hex characters. It is sized for
// unguessability rather than collision avoidance: media is served from an
// unauthenticated route (see src/media), so the key is the only thing standing
// between a URL and the file. An earlier version sliced 8 *characters* off a
// UUID, which is 4 bytes — half the bits the comment there claimed.
export const makeKey = (filename: string): string => {
  const stamp = new Date()
  const year = stamp.getUTCFullYear()
  const month = String(stamp.getUTCMonth() + 1).padStart(2, "0")
  const unique = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
  return `${year}/${month}/${unique}/${sanitize(filename)}`
}

export const sanitize = (filename: string): string => {
  const cleaned = filename
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(-120)
  return cleaned || "file"
}

export const put = (store: StorageDriver, key: string, body: Blob | Uint8Array | string, contentType: string) =>
  store.put(key, body, contentType)

export const get = (store: StorageDriver, key: string) => store.get(key)

export const drop = (store: StorageDriver, key: string) => store.drop(key)
