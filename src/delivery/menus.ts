import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import { rows } from "../db/dialect.ts"
import { type KeyIdentity, keyAllows } from "../keys/index.ts"
import { type MenuItem, safeUrl } from "../menus/index.ts"

type Destination = { id: string; slug: string; locale: string; name: string; preview_url: string | null }

export const resolveMenu = async (db: Connection, items: MenuItem[], identity: KeyIdentity): Promise<MenuItem[]> => {
  const ids = new Set<string>()
  const collect = (links: readonly MenuItem[]) => {
    for (const item of links) {
      if (item.entryId) ids.add(item.entryId)
      if (item.children) collect(item.children)
    }
  }
  collect(items)
  if (!ids.size) return items
  const found = await rows<Destination>(
    db,
    from("entries", "e")
      .select("e.id", "e.slug", "e.locale", "ct.name", "ct.preview_url")
      .join("content_types", "ct.id = e.content_type_id", "ct")
      .where(q => q("e.id").inList([...ids]))
      .where(q => q("e.status").equals("published"))
      .where(q => q("e.deleted_at").isNull()),
  )
  const urls = new Map<string, string>()
  for (const entry of found) {
    if (!entry.preview_url || !keyAllows(identity, entry.name)) continue
    const url = entry.preview_url
      .replaceAll("{id}", encodeURIComponent(entry.id))
      .replaceAll("{slug}", encodeURIComponent(entry.slug))
      .replaceAll("{locale}", encodeURIComponent(entry.locale))
      .replaceAll("{type}", encodeURIComponent(entry.name))
    if (safeUrl(url)) urls.set(entry.id, url)
  }
  const resolve = (links: readonly MenuItem[]): MenuItem[] =>
    links.flatMap(item => {
      const children = item.children ? resolve(item.children) : undefined
      const url = item.entryId ? urls.get(item.entryId) : item.url
      if (item.entryId && !url && !children?.length) return []
      return [{ ...item, ...(item.entryId ? { url } : {}), ...(children ? { children } : {}) }]
    })
  return resolve(items)
}
