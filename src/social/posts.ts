import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import { badRequest } from "atlas/server"
import { countRows, one, paging, rows as query } from "../db/dialect.ts"
import { id as newId } from "../ids/index.ts"
import { decodeArray, decodeObject, encode } from "../json/index.ts"
import { socialPosts, socialTargets } from "../schema/index.ts"
import type { StorageDriver } from "../storage/index.ts"
import { now, parseIso } from "../time/index.ts"
import type { AccountRow } from "./accounts.ts"
import { list as listAccounts } from "./accounts.ts"
import { attachments, shapeOf } from "./media.ts"
import { networkFor, networkLabel, violations, withDefaults } from "./networks.ts"

// A post and where it is going. One table each, because those are two different
// lifetimes: the copy stops changing when it is sent, and what each network did
// with it keeps changing afterwards.

export type PostRow = {
  id: string
  title: string
  caption: string
  link: string | null
  media: string
  status: string
  scheduled_at: string | null
  published_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export type TargetRow = {
  id: string
  post_id: string
  account_id: string | null
  network: string
  caption: string | null
  options: string
  status: string
  remote_id: string | null
  remote_url: string | null
  error: string | null
  attempts: number
  posted_at: string | null
  created_at: string
  updated_at: string
}

// Everything not yet sent. `publishing` is held for the length of a send and is
// what stops the sweep picking up a post the previous tick is still working on.
export const OPEN_STATUSES = ["draft", "scheduled", "publishing"] as const

export type PostInput = {
  readonly title: string
  readonly caption: string
  readonly link: string | null
  readonly media: readonly string[]
  readonly scheduledAt: string | null
  readonly targets: readonly {
    readonly accountId: string
    readonly caption: string | null
    readonly options: Record<string, unknown>
  }[]
}

// --------------------------------------------------------------- presenting

export const captionFor = (post: Pick<PostRow, "caption">, target: Pick<TargetRow, "caption">): string =>
  // NULL means "follow the post", empty string means "this network gets none".
  // Collapsing the two would make an edit to the post's caption silently skip
  // whichever network someone had cleared on purpose.
  target.caption === null ? post.caption : target.caption

const presentTarget = (row: TargetRow, account?: AccountRow) => ({
  id: row.id,
  accountId: row.account_id,
  network: row.network,
  networkLabel: networkLabel(row.network),
  account: account?.account_name ?? null,
  // A target whose account was disconnected can still be read; it just cannot
  // be sent, and saying so here is cheaper than the screen working it out.
  connected: account !== undefined,
  caption: row.caption,
  options: decodeObject(row.options),
  status: row.status,
  remoteId: row.remote_id,
  url: row.remote_url,
  error: row.error,
  attempts: row.attempts,
  postedAt: row.posted_at,
})

export const present = (row: PostRow, targets: readonly TargetRow[], accounts: ReadonlyMap<string, AccountRow>) => ({
  id: row.id,
  title: row.title,
  caption: row.caption,
  link: row.link,
  media: decodeArray<string>(row.media),
  status: row.status,
  scheduledAt: row.scheduled_at,
  publishedAt: row.published_at,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  targets: targets
    .filter(target => target.post_id === row.id)
    .map(target => presentTarget(target, accounts.get(target.account_id ?? ""))),
})

export type PostView = ReturnType<typeof present>

// ----------------------------------------------------------------- reading

export const byId = (db: Connection, id: string): Promise<PostRow | null> =>
  one<PostRow>(
    db,
    from("social_posts", "p")
      .where(q => q("p.id").equals(id))
      .where(q => q("p.deleted_at").isNull()),
  )

export const targetsFor = (db: Connection, postIds: readonly string[]): Promise<TargetRow[]> =>
  postIds.length === 0
    ? Promise.resolve([])
    : query<TargetRow>(
        db,
        from("social_targets", "t")
          .where(q => q("t.post_id").inList([...postIds]))
          .orderBy("t.network", "ASC"),
      )

// "open" is the one filter that is not a status: everything not yet sent, which
// is what the queue means and what no single status spells.
const listing = (filters: { status?: string }) => {
  const builder = from("social_posts", "p").where(q => q("p.deleted_at").isNull())
  if (filters.status === "open") return builder.where(q => q("p.status").inList([...OPEN_STATUSES]))
  return filters.status ? builder.where(q => q("p.status").equals(filters.status as string)) : builder
}

export const list = async (
  db: Connection,
  params: { status?: string; limit?: string; page?: string; offset?: string },
): Promise<{ posts: PostRow[]; total: number; limit: number; page: number }> => {
  const { limit, offset, page } = paging(params, 25, 100)

  const total = await countRows(db, listing(params).select("COUNT(*) as total"))
  const posts = await query<PostRow>(
    db,
    listing(params)
      // Scheduled work reads forward and everything else reads backward, but a
      // single list has to pick one. Newest-touched keeps a draft someone is
      // mid-way through at the top, which is the post they came back for.
      .orderBy("p.updated_at", "DESC")
      .limit(limit)
      .offset(offset),
  )

  return { posts, total, limit, page }
}

// The calendar and the queue are the same query with different bounds, so they
// are one function: everything not yet sent, plus everything sent inside the
// window, ordered by when it goes out rather than when it was touched.
export const timeline = async (db: Connection, fromIso: string, toIso: string): Promise<PostRow[]> =>
  query<PostRow>(
    db,
    from("social_posts", "p")
      .where(q => q("p.deleted_at").isNull())
      .where(q => q("p.scheduled_at").greaterThanOrEqual(fromIso))
      .where(q => q("p.scheduled_at").lessThanOrEqual(toIso))
      .orderBy("p.scheduled_at", "ASC")
      .limit(500),
  )

// ----------------------------------------------------------------- writing

const titleFrom = (title: string, caption: string): string => {
  const supplied = title.trim()
  if (supplied) return supplied.slice(0, 160)
  const first = caption.trim().split(/\s+/).slice(0, 9).join(" ")
  return first ? first.slice(0, 160) : "Untitled post"
}

// Everything a network will refuse, worked out before the post is stored rather
// than at 6am on Saturday when the sweep finds it. A scheduled post that cannot
// be sent is a notification nobody reads.
export const check = async (
  db: Connection,
  store: StorageDriver,
  input: PostInput,
  accounts: readonly AccountRow[],
): Promise<{ ok: true } | { ok: false; problems: { key: string; message: string }[] }> => {
  const problems: { key: string; message: string }[] = []
  const items = await attachments(db, store, input.media)

  if (items.length !== input.media.length) {
    problems.push({ key: "media", message: "Some of the attached media no longer exists" })
  }

  const shape = shapeOf(items)
  const byId = new Map(accounts.map(account => [account.id, account]))
  const seen = new Set<string>()

  for (const target of input.targets) {
    const account = byId.get(target.accountId)
    if (!account) {
      problems.push({ key: "targets", message: "One of the selected accounts is no longer connected" })
      continue
    }
    if (seen.has(account.id)) {
      problems.push({ key: "targets", message: `${networkLabel(account.network)} is selected twice` })
      continue
    }
    seen.add(account.id)

    if (!networkFor(account.network)) {
      problems.push({ key: "targets", message: `Inkling cannot post to ${account.network}` })
      continue
    }

    const caption = target.caption === null ? input.caption : target.caption
    for (const message of violations(account.network, caption, shape)) {
      problems.push({ key: `targets.${account.id}`, message })
    }
  }

  if (input.targets.length === 0) problems.push({ key: "targets", message: "Choose at least one account to post to" })

  return problems.length === 0 ? { ok: true } : { ok: false, problems }
}

const replaceTargets = async (db: Connection, postId: string, input: PostInput, accounts: readonly AccountRow[]) => {
  const byId = new Map(accounts.map(account => [account.id, account]))
  const existing = await targetsFor(db, [postId])
  const keep = new Map(existing.map(row => [row.account_id ?? "", row]))
  const stamp = now()

  for (const target of input.targets) {
    const account = byId.get(target.accountId)
    if (!account) continue

    const options = encode(withDefaults(account.network, target.options))
    const previous = keep.get(account.id)

    if (previous) {
      keep.delete(account.id)
      // A target that already went out keeps its copy and its link. Rewriting
      // it would leave the row describing a post that is not what is live.
      if (previous.status === "posted") continue
      await db.execute(
        from(socialTargets)
          .update({ caption: target.caption, options, network: account.network, updated_at: stamp })
          .where(q => q("id").equals(previous.id)),
      )
      continue
    }

    await db.execute(
      from(socialTargets).insert({
        id: newId(),
        post_id: postId,
        account_id: account.id,
        network: account.network,
        caption: target.caption,
        options,
        status: "pending",
        remote_id: null,
        remote_url: null,
        error: null,
        attempts: 0,
        posted_at: null,
        created_at: stamp,
        updated_at: stamp,
      }),
    )
  }

  // Deselecting a network that already posted cannot unsend it, so the row
  // stays and the history stays readable. Anything else is removed.
  for (const orphan of keep.values()) {
    if (orphan.status === "posted") continue
    await db.execute(
      from(socialTargets)
        .where(q => q("id").equals(orphan.id))
        .del(),
    )
  }
}

export const create = async (
  db: Connection,
  store: StorageDriver,
  input: PostInput,
  userId: string | null,
): Promise<PostRow> => {
  const accounts = await listAccounts(db)
  const verdict = await check(db, store, input, accounts)
  if (!verdict.ok)
    throw badRequest("This post cannot go out as written", {
      code: "SOCIAL_INVALID",
      details: { fields: verdict.problems.map(problem => ({ key: problem.key, message: problem.message })) },
    })

  const stamp = now()
  const scheduledAt = parseIso(input.scheduledAt)
  const row: PostRow = {
    id: newId(),
    title: titleFrom(input.title, input.caption),
    caption: input.caption,
    link: input.link,
    media: encode([...input.media]),
    status: scheduledAt ? "scheduled" : "draft",
    scheduled_at: scheduledAt,
    published_at: null,
    created_by: userId,
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
  }

  await db.execute(from(socialPosts).insert(row))
  await replaceTargets(db, row.id, input, accounts)
  return row
}

export const update = async (
  db: Connection,
  store: StorageDriver,
  row: PostRow,
  input: PostInput,
): Promise<PostRow> => {
  if (row.status === "publishing") {
    throw badRequest("This post is going out right now", { code: "SOCIAL_BUSY" })
  }

  const accounts = await listAccounts(db)
  const verdict = await check(db, store, input, accounts)
  if (!verdict.ok)
    throw badRequest("This post cannot go out as written", {
      code: "SOCIAL_INVALID",
      details: { fields: verdict.problems.map(problem => ({ key: problem.key, message: problem.message })) },
    })

  const scheduledAt = parseIso(input.scheduledAt)
  // A post that has already gone out keeps its status: editing it here changes
  // what Inkling holds, not what is live on a network.
  const settled = row.status === "posted" || row.status === "partial" || row.status === "failed"
  const fields = {
    title: titleFrom(input.title, input.caption),
    caption: input.caption,
    link: input.link,
    media: encode([...input.media]),
    status: settled ? row.status : scheduledAt ? "scheduled" : "draft",
    scheduled_at: scheduledAt,
    updated_at: now(),
  }

  await db.execute(
    from(socialPosts)
      .update(fields)
      .where(q => q("id").equals(row.id)),
  )
  await replaceTargets(db, row.id, input, accounts)
  return { ...row, ...fields }
}

export const setStatus = async (db: Connection, id: string, status: string, publishedAt?: string | null) => {
  await db.execute(
    from(socialPosts)
      .update({
        status,
        updated_at: now(),
        ...(publishedAt === undefined ? {} : { published_at: publishedAt }),
      })
      .where(q => q("id").equals(id)),
  )
}

export const remove = async (db: Connection, id: string): Promise<void> => {
  await db.execute(
    from(socialPosts)
      .update({ deleted_at: now(), updated_at: now() })
      .where(q => q("id").equals(id)),
  )
}

// Reads a payload from the admin into the shape the rest of this module wants.
// Unknown keys are dropped rather than stored: `options` is written straight
// into a column that publishers read, so it is validated against what the
// network declares (see withDefaults) instead of trusted.
export const readInput = (body: Record<string, unknown>): PostInput => {
  const media = Array.isArray(body.media) ? body.media.filter(item => typeof item === "string").slice(0, 20) : []
  const rawTargets = Array.isArray(body.targets) ? body.targets : []

  return {
    title: typeof body.title === "string" ? body.title : "",
    caption: typeof body.caption === "string" ? body.caption : "",
    link: typeof body.link === "string" && body.link.trim() !== "" ? body.link.trim() : null,
    media: media as string[],
    scheduledAt: typeof body.scheduledAt === "string" ? body.scheduledAt : null,
    targets: rawTargets.slice(0, 20).flatMap(item => {
      const target = (item ?? {}) as Record<string, unknown>
      const accountId = typeof target.accountId === "string" ? target.accountId : ""
      if (!accountId) return []
      return [
        {
          accountId,
          caption: typeof target.caption === "string" ? target.caption : null,
          options:
            typeof target.options === "object" && target.options !== null
              ? (target.options as Record<string, unknown>)
              : {},
        },
      ]
    }),
  }
}
