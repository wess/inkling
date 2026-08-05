import { createStore, download, remove, upload } from "atlas/storage"
import type { StorageDriver } from "../index.ts"

type S3Settings = {
  readonly endpoint: string
  readonly bucket: string
  readonly region: string
  readonly accessKey: string
  readonly secretKey: string
  readonly publicUrl: string
}

// Wraps atlas/storage. Reads still flow through the media API rather than
// handing clients a bucket URL, so the driver exposes `get` as a stream and
// never a presigned link — see the note in ../index.ts.
export const createS3Driver = (settings: S3Settings): StorageDriver => {
  if (!settings.bucket) throw new Error("STORAGE_DRIVER=s3 requires S3_BUCKET")
  if (!settings.endpoint) throw new Error("STORAGE_DRIVER=s3 requires S3_ENDPOINT")

  const store = createStore({
    endpoint: settings.endpoint,
    bucket: settings.bucket,
    accessKey: settings.accessKey,
    secretKey: settings.secretKey,
    region: settings.region || undefined,
  })

  return {
    kind: "s3",

    put: async (key, body, contentType) => {
      const result = await upload(store, { key, body, contentType })
      // A CDN in front of the bucket is the common production setup; fall back
      // to whatever the SDK reports when one isn't configured.
      return { url: settings.publicUrl ? `${settings.publicUrl.replace(/\/+$/, "")}/${key}` : result.url }
    },

    get: async key => {
      const response = await download(store, key)
      return response.ok ? response.body : null
    },

    drop: async key => {
      await remove(store, key).catch(() => {})
    },
  }
}
