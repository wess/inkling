import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import { rows as query } from "../db/dialect.ts"
import { decodeArray, decodeObject } from "../json/index.ts"
import type { Hooks } from "../plugins/hooks.ts"
import { socialPosts, socialTargets } from "../schema/index.ts"
import type { StorageDriver } from "../storage/index.ts"
import { now } from "../time/index.ts"
import type { AccountRow } from "./accounts.ts"
import { accessToken, list as listAccounts } from "./accounts.ts"
import { attachments } from "./media.ts"
import { withDefaults } from "./networks.ts"
import type { PostRow, TargetRow } from "./posts.ts"
import { captionFor, setStatus, targetsFor } from "./posts.ts"
import { publish as facebook } from "./publishers/facebook.ts"
import { publish as googlebusiness } from "./publishers/googlebusiness.ts"
import type { Published } from "./publishers/index.ts"
import { publish as instagram } from "./publishers/instagram.ts"
import { publish as linkedin } from "./publishers/linkedin.ts"
import { publish as pinterest } from "./publishers/pinterest.ts"
import { publish as threads } from "./publishers/threads.ts"
import { publish as tiktok } from "./publishers/tiktok.ts"
import { publish as x } from "./publishers/x.ts"
import { publish as youtube } from "./publishers/youtube.ts"

// Sending a post. One target at a time, each one recording its own outcome, and
// nothing about one network's failure reaching another's.
//
// That independence is the whole design. A post to four networks has sixteen
// interesting outcomes and only one of them is "it worked"; a run that stopped
// at the first refusal would leave three networks unattempted and one row
// saying "failed", which is a description of neither what happened nor what to
// do about it. So every target is tried, every failure is stored with the
// network's own words next to it, and the post's own status is a summary of
// what its targets did rather than a thing that is set.

// Keyed by the same string ./networks.ts uses, and every network in that
// catalog has an entry here. A network in one and not the other is the failure
// both files exist to prevent — a connect button that leads nowhere — so
// tests/social.test.ts asserts the two lists match.
const PUBLISHERS: Record<string, (context: Parameters<typeof x>[0]) => Promise<Published>> = {
  x,
  facebook,
  instagram,
  threads,
  linkedin,
  tiktok,
  youtube,
  pinterest,
  googlebusiness,
}

export const publishable = (network: string): boolean => network in PUBLISHERS

const stamp = async (db: Connection, id: string, fields: Record<string, unknown>): Promise<void> => {
  await db.execute(
    from(socialTargets)
      .update({ ...fields, updated_at: now() })
      .where(q => q("id").equals(id)),
  )
}

// A post is as done as its worst target. `partial` exists because it is the
// common case and neither "posted" nor "failed" is honest about it.
export const rollUp = (targets: readonly Pick<TargetRow, "status">[]): string => {
  const relevant = targets.filter(target => target.status !== "skipped")
  if (relevant.length === 0) return "failed"
  if (relevant.some(target => target.status === "pending" || target.status === "publishing")) return "scheduled"
  const posted = relevant.filter(target => target.status === "posted").length
  if (posted === relevant.length) return "posted"
  if (posted === 0) return "failed"
  return "partial"
}

export type Outcome = {
  readonly postId: string
  readonly status: string
  readonly targets: {
    readonly id: string
    readonly network: string
    readonly status: string
    readonly error: string | null
  }[]
}

const BACKOFF_MINUTES = [1, 5, 15, 60]
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1
const PERMANENT = [
  /invalid[_ ]?(request|payload|parameter)/i,
  /duplicate|already (exists|published|posted)/i,
  /not authorized|unauthorized|forbidden|permission/i,
  /token (is )?(expired|invalid|revoked)/i,
  /too long|exceeds maximum|character limit/i,
  /unsupported (media|format)/i,
  /rejected/i,
  /no longer connected|reconnect|could not be renewed/i,
]

const isPermanent = (message: string): boolean => PERMANENT.some(pattern => pattern.test(message))

const retryAt = (attempt: number): string =>
  new Date(
    Date.now() + (BACKOFF_MINUTES[attempt - 1] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1] ?? 1) * 60_000,
  ).toISOString()

// Runs every pending target on one post. Safe to call on a post whose status is
// already `publishing` only because the caller claimed it — see `claim` below.
export const send = async (
  db: Connection,
  store: StorageDriver,
  post: PostRow,
  hooks?: Hooks,
  force = false,
): Promise<Outcome> => {
  const [targets, accounts] = await Promise.all([targetsFor(db, [post.id]), listAccounts(db)])
  const byId = new Map<string, AccountRow>(accounts.map(account => [account.id, account]))
  const media = await attachments(db, store, decodeArray<string>(post.media))

  const results: Outcome["targets"] = []

  for (const target of targets) {
    if (!force && target.status === "pending" && target.next_attempt_at && target.next_attempt_at > now()) {
      results.push({ id: target.id, network: target.network, status: "pending", error: target.error })
      continue
    }
    // Already sent. Re-running a post — after fixing the one network that
    // refused it — must not post twice to the three that did not.
    if (target.status === "posted") {
      results.push({ id: target.id, network: target.network, status: "posted", error: null })
      continue
    }

    const account = byId.get(target.account_id ?? "")
    const publisher = PUBLISHERS[target.network]

    const refuse = async (message: string) => {
      const attempts = target.attempts + 1
      const permanent = isPermanent(message)
      const exhausted = permanent || attempts >= MAX_ATTEMPTS
      const status = exhausted ? "failed" : "pending"
      await stamp(db, target.id, {
        status,
        error: message,
        error_code: permanent ? "permanent" : exhausted ? "exhausted" : "transient",
        attempts,
        next_attempt_at: exhausted ? null : retryAt(attempts),
      })
      results.push({ id: target.id, network: target.network, status, error: message })
    }

    if (!account) {
      await refuse("That account is no longer connected. Reconnect it and send again.")
      continue
    }
    if (!publisher) {
      await refuse(`Inkling cannot post to ${target.network}`)
      continue
    }

    const token = await accessToken(db, account)
    if (!token) {
      await refuse(account.error ?? "That connection could not be renewed. Reconnect it and send again.")
      continue
    }

    await stamp(db, target.id, { status: "publishing", error: null })

    try {
      const landed = await publisher({
        account,
        token,
        caption: captionFor(post, target),
        link: post.link,
        media,
        options: withDefaults(target.network, decodeObject(target.options)),
        title: post.title,
      })

      await stamp(db, target.id, {
        status: "posted",
        remote_id: landed.remoteId,
        remote_url: landed.url,
        error: null,
        error_code: null,
        attempts: target.attempts + 1,
        next_attempt_at: null,
        posted_at: now(),
      })
      results.push({ id: target.id, network: target.network, status: "posted", error: null })
    } catch (error) {
      await refuse(error instanceof Error ? error.message : "That network refused the post")
    }
  }

  const status = rollUp(results)
  const posted = results.some(result => result.status === "posted")
  await setStatus(db, post.id, status, posted ? (post.published_at ?? now()) : post.published_at)

  // Observation only, and after the fact. A listener cannot stop a post going
  // out because by the time this runs it already has.
  await hooks?.emit("social.posted", {
    id: post.id,
    title: post.title,
    status,
    targets: results,
  })

  return { postId: post.id, status, targets: results }
}

// Marks a post as ours to send, and refuses if someone else got there first.
// The UPDATE is the lock: it matches on the status it expects to replace, so
// two sweeps racing means one of them changes no rows and stops.
export const claim = async (db: Connection, id: string, expected: readonly string[]): Promise<PostRow | null> => {
  const [before] = await query<PostRow>(
    db,
    from("social_posts", "p")
      .where(q => q("p.id").equals(id))
      .where(q => q("p.deleted_at").isNull())
      .where(q => q("p.status").inList([...expected])),
  )
  if (!before) return null

  const changed = await db.execute(
    from(socialPosts)
      .update({ status: "publishing", updated_at: now() })
      .where(q => q("id").equals(id))
      .where(q => q("status").inList([...expected])),
  )

  // Drivers disagree about what they report for an UPDATE, so a count of
  // undefined is treated as "it happened" — the read above already narrowed it,
  // and the sweep runs in one process.
  const rows = (changed as { rowCount?: number; changes?: number } | undefined) ?? {}
  const affected = rows.rowCount ?? rows.changes
  if (affected === 0) return null

  return { ...before, status: "publishing" }
}

// The sweep. Scheduled posts whose time has come, plus anything left in
// `publishing` by a process that died mid-send — the second is why the window
// is a lower bound rather than an equality: a post nobody will ever finish is
// worse than one attempted twice, and every target already knows whether it
// went out.
export const publishDue = async (db: Connection, store: StorageDriver, hooks?: Hooks): Promise<Outcome[]> => {
  const at = now()
  const stale = new Date(Date.now() - 15 * 60_000).toISOString()

  const due = await query<PostRow>(
    db,
    from("social_posts", "p")
      .where(q => q("p.deleted_at").isNull())
      .where(q => q("p.scheduled_at").lessThanOrEqual(at))
      .where(q => q("p.status").inList(["scheduled"]))
      .orderBy("p.scheduled_at", "ASC")
      .limit(25),
  )

  const abandoned = await query<PostRow>(
    db,
    from("social_posts", "p")
      .where(q => q("p.deleted_at").isNull())
      .where(q => q("p.status").equals("publishing"))
      .where(q => q("p.updated_at").lessThanOrEqual(stale))
      .limit(10),
  )

  const outcomes: Outcome[] = []
  for (const post of [...due, ...abandoned]) {
    const claimed = await claim(db, post.id, [post.status])
    if (!claimed) continue
    outcomes.push(await send(db, store, claimed, hooks))
  }

  return outcomes
}
