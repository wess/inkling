import { mkdirSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import type { StorageDriver } from "../index.ts"

// Disk-backed driver for single-host deployments and local development.
// Objects are served back through the media API, never by a static file server,
// so the traversal guard below is the only thing standing between a crafted key
// and the rest of the filesystem — it stays even though keys are generated
// server-side, because a key also arrives from the database on every read.
export const createLocalDriver = (dir: string): StorageDriver => {
  const root = resolve(dir)
  mkdirSync(root, { recursive: true })

  const pathFor = (key: string): string => {
    const target = resolve(join(root, key))
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`Refusing storage key that escapes the storage root: ${key}`)
    }
    return target
  }

  return {
    kind: "local",

    put: async (key, body, _contentType) => {
      const target = pathFor(key)
      mkdirSync(dirname(target), { recursive: true })
      await Bun.write(target, body)
      return { url: `/media/file/${key}` }
    },

    get: async key => {
      const file = Bun.file(pathFor(key))
      return (await file.exists()) ? file.stream() : null
    },

    drop: async key => {
      await Bun.file(pathFor(key))
        .delete()
        .catch(() => {})
    },
  }
}
