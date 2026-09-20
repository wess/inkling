import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import { badRequest } from "atlas/server"
import { byName } from "../../src/contenttypes/index.ts"
import { rows } from "../../src/db/dialect.ts"
import type { EntryRow } from "../../src/entries/index.ts"
import { slugify } from "../../src/ids/index.ts"
import { decodeObject } from "../../src/json/index.ts"
import { createAudit } from "../../src/security/index.ts"
import type { CatalogObject } from "./catalog.ts"
import type { Account } from "./connection.ts"

export type ProductRow = EntryRow & { item_id: string }

export const products = (account: Account, published = true) => {
  let query = from("entries", "e")
    .join("square_products", "s.entry_id = e.id", "s")
    .join("content_types", "t.id = e.content_type_id", "t")
    .select("e.*", "s.item_id")
    .where(q => q("t.name").equals("shopproduct"))
    .where(q => q("t.owner_plugin").equals("commerce"))
    .where(q => q("s.merchant_id").equals(account.merchant_id))
    .where(q => q("s.environment").equals(account.environment))
    .where(q => q("e.deleted_at").isNull())
  if (published) query = query.where(q => q("e.status").equals("published"))
  return query.orderBy("e.sort_order", "ASC").orderBy("e.id", "ASC")
}

export const presentation = (row: ProductRow) => {
  const data = decodeObject(row.data)
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: data.description ?? "",
    image: data.image ?? null,
    gallery: data.gallery ?? [],
    featured: data.featured === true,
  }
}

export const addProduct = async (
  db: Connection,
  account: Account,
  item: CatalogObject,
  userId: string,
): Promise<string> => {
  const existing = await rows<{ entry_id: string; deleted_at: string | null }>(
    db,
    from("square_products", "s")
      .join("entries", "e.id = s.entry_id", "e")
      .select("s.entry_id", "e.deleted_at")
      .where(q => q("merchant_id").equals(account.merchant_id))
      .where(q => q("environment").equals(account.environment))
      .where(q => q("item_id").equals(item.id)),
  )
  if (existing[0]?.deleted_at)
    throw badRequest("This product already has a page in Trash. Restore that page before adding it again.")
  if (existing[0]) return existing[0].entry_id
  const type = await byName(db, "shopproduct")
  if (!type || type.owner_plugin !== "commerce") throw badRequest("Enable Ecommerce before adding shop pages")
  const id = crypto.randomUUID()
  const stamp = new Date().toISOString()
  const title = item.item_data?.name ?? "New shop page"
  await db.transaction(async tx => {
    await tx.execute(
      from("entries").insert({
        id,
        content_type_id: type.id,
        title,
        slug: `${slugify(title)}-${id.slice(0, 8)}`,
        data: JSON.stringify({ description: "", featured: false }),
        status: "draft",
        locale: "en",
        author_id: userId,
        sort_order: 0,
        published_at: null,
        scheduled_at: null,
        created_at: stamp,
        updated_at: stamp,
        deleted_at: null,
      }),
    )
    await tx.execute(
      from("square_products").insert({
        entry_id: id,
        merchant_id: account.merchant_id,
        environment: account.environment,
        item_id: item.id,
      }),
    )
    await tx.execute(
      from("revisions").insert({
        id: crypto.randomUUID(),
        entry_id: id,
        title,
        data: JSON.stringify({ description: "", featured: false }),
        status: "draft",
        author_id: userId,
        note: "Added from Square",
        created_at: stamp,
      }),
    )
  })
  await createAudit(db).log({ userId, event: "square.product.added", metadata: { entryId: id, itemId: item.id } })
  return id
}
