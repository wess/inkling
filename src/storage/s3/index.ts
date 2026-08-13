import { signRequest } from "atlas/packages/storage/signing/index.ts"
import { createStore, download, remove, upload } from "atlas/storage"
import type { StorageDriver } from "../index.ts"

type S3Settings = {
  readonly endpoint: string
  readonly bucket: string
  readonly region: string
  readonly accessKey: string
  readonly secretKey: string
  readonly publicUrl: string
  readonly prefix: string
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

  // The prefix is bucket layout, not content, so it lives here rather than in
  // `makeKey` — `storage_key` in the database stays prefix-free. That is what
  // lets several sites share one bucket while each database stays portable:
  // move a site to its own bucket, or drop the prefix, and no row has to change.
  const trimmed = settings.prefix.replace(/^\/+|\/+$/g, "")
  const scoped = (key: string): string => (trimmed ? `${trimmed}/${key}` : key)

  // Objects land private, so a bucket served straight to browsers needs each
  // one marked public-read at write time. atlas/storage's `upload` sends no
  // header but content-type, and a Spaces key scoped with grants is refused
  // PutBucketPolicy (403), so neither the library nor a one-time bucket policy
  // can do it — hence this one signed PUT. Everything else still goes through
  // atlas. The durable fix is an `acl` option on atlas/storage#upload.
  const uploadPublic = async (key: string, body: Blob | Uint8Array | string, contentType: string) => {
    const bytes =
      typeof body === "string"
        ? new TextEncoder().encode(body)
        : body instanceof Blob
          ? new Uint8Array(await body.arrayBuffer())
          : body
    const url = new URL(`/${settings.bucket}/${key}`, store.endpoint)
    const headers = new Headers({ host: url.host, "content-type": contentType, "x-amz-acl": "public-read" })

    // signRequest fills in x-amz-date and x-amz-content-sha256 on the way past.
    const signed = signRequest({
      method: "PUT",
      url,
      headers,
      body: bytes,
      accessKey: store.accessKey,
      secretKey: store.secretKey,
      region: store.region,
      service: "s3",
    })
    headers.set("authorization", signed.authorization)

    const response = await fetch(url.toString(), {
      method: "PUT",
      headers,
      body: bytes as unknown as RequestInit["body"],
    })
    if (!response.ok) {
      throw new Error(`Storage upload failed for key '${key}': HTTP ${response.status} ${await response.text()}`)
    }
  }

  return {
    kind: "s3",

    put: async (key, body, contentType) => {
      if (settings.publicUrl) await uploadPublic(scoped(key), body, contentType)
      else await upload(store, { key: scoped(key), body, contentType })
      // Only a configured CDN/public base earns an absolute URL, and that is
      // also what decides the ACL above — the two have to agree, or the CMS
      // hands consuming sites links only the CMS itself can fetch. Without one
      // we return the same root-relative path the local driver does, so reads
      // go back through /media/file, the guarded path this module documents.
      return {
        url: settings.publicUrl ? `${settings.publicUrl.replace(/\/+$/, "")}/${scoped(key)}` : `/media/file/${key}`,
      }
    },

    // A missing object is `null`, not a throw — the media route turns that into
    // a 404, and the local driver already behaves this way. atlas/storage's
    // `download` throws on any non-2xx, so unpack the status back out. Anything
    // we can't positively identify as a 404 is rethrown: a credential or
    // network failure must not be laundered into "this file doesn't exist".
    get: async key => {
      try {
        const response = await download(store, scoped(key))
        return response.body
      } catch (error) {
        if (/\bHTTP 404\b/.test(String(error))) return null
        throw error
      }
    },

    drop: async key => {
      await remove(store, scoped(key)).catch(() => {})
    },
  }
}
