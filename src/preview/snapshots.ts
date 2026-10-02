import type { Connection } from "atlas/db"
import { badRequest } from "atlas/server"
import type { EntryRow } from "../entries/index.ts"

const MAX_BYTES = 16 * 1024 * 1024
export const MAX_SNAPSHOT_BYTES = 1024 * 1024

type Snapshot = { row: EntryRow; expiresAt: number; bytes: number }
type SnapshotStore = {
  put: (row: EntryRow, expiresAt: number) => string
  get: (key: string) => EntryRow | null
}

export const createSnapshotStore = (clock = Date.now): SnapshotStore => {
  const snapshots = new Map<string, Snapshot>()
  let bytes = 0
  const discard = (key: string) => {
    bytes -= snapshots.get(key)?.bytes ?? 0
    snapshots.delete(key)
  }
  const expire = () => {
    for (const [key, value] of snapshots) if (value.expiresAt <= clock()) discard(key)
  }
  return {
    put: (row, expiresAt) => {
      const size = Buffer.byteLength(JSON.stringify(row))
      if (size > MAX_SNAPSHOT_BYTES) throw badRequest("This preview is too large", { code: "PREVIEW_TOO_LARGE" })
      expire()
      for (const key of snapshots.keys()) {
        if (snapshots.size < 100 && bytes + size <= MAX_BYTES) break
        discard(key)
      }
      const key = crypto.randomUUID()
      snapshots.set(key, { row: { ...row }, expiresAt, bytes: size })
      bytes += size
      return key
    },
    get: key => {
      expire()
      return snapshots.get(key)?.row ?? null
    },
  }
}

const stores = new WeakMap<Connection, SnapshotStore>()

export const snapshotsFor = (db: Connection): SnapshotStore => {
  let store = stores.get(db)
  if (!store) {
    store = createSnapshotStore()
    stores.set(db, store)
  }
  return store
}
