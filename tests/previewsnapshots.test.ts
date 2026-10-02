import { expect, test } from "bun:test"
import type { EntryRow } from "../src/entries/index.ts"
import { createSnapshotStore } from "../src/preview/snapshots.ts"

const row: EntryRow = {
  id: "one",
  content_type_id: "page",
  title: "Title",
  slug: "title",
  data: "{}",
  status: "published",
  locale: "en",
  author_id: null,
  sort_order: 0,
  published_at: null,
  scheduled_at: null,
  created_at: "",
  updated_at: "",
  deleted_at: null,
}

test("preview snapshots expire and evict the oldest snapshots at their count bound", () => {
  let now = 1000
  const store = createSnapshotStore(() => now)
  const first = store.put(row, 2000)
  const next = store.put({ ...row, title: "Second" }, 3000)
  now = 2000
  expect(store.get(first)).toBeNull()
  expect(store.get(next)?.title).toBe("Second")
  for (let index = 0; index < 100; index += 1) store.put(row, 3000)
  expect(store.get(next)).toBeNull()
})

test("preview snapshots bound both single draft and aggregate memory", () => {
  const store = createSnapshotStore(() => 1000)
  expect(() => store.put({ ...row, data: "x".repeat(1024 * 1024) }, 2000)).toThrow("too large")
  const large = { ...row, data: "x".repeat(900_000) }
  const first = store.put(large, 2000)
  let last = ""
  for (let index = 0; index < 20; index += 1) last = store.put(large, 2000)
  expect(store.get(first)).toBeNull()
  expect(store.get(last)?.id).toBe("one")
})
