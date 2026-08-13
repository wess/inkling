import { afterEach, expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import { issueSession } from "../src/auth/index.ts"
import { id } from "../src/ids/index.ts"
import { up } from "../src/migrate/index.ts"
import { createHooks } from "../src/plugins/hooks.ts"
import { media } from "../src/schema/index.ts"
import { remove as removeAccount, save as saveAccount } from "../src/social/accounts.ts"
import { socialRoutes } from "../src/social/index.ts"
import { publishDue } from "../src/social/publish.ts"
import type { StorageDriver } from "../src/storage/index.ts"
import { now } from "../src/time/index.ts"
import { createUser } from "../src/users/index.ts"

// The Social section driven through its own routes, because everything
// interesting about it is a question about who is asking and what a network
// said back — neither of which a unit test of the data layer can see.

const store: StorageDriver = {
  kind: "memory",
  put: async () => ({ url: "/media/file/nothing" }),
  get: async () => null,
  drop: async () => {},
}

const setup = async (role: "author" | "editor" | "admin" = "editor") => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")

  const user = await createUser(db, {
    email: `${role}@example.com`,
    name: "Tester",
    password: "a secure password",
    role,
  })
  const session = await issueSession(db, user, { ip: "127.0.0.1", userAgent: "tests" })

  const hooks = createHooks(() => {})
  const handle = router(...socialRoutes(db, store, hooks))

  const call = (method: string, path: string, body?: unknown) =>
    handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          authorization: `Bearer ${session.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )

  const connectAccount = (network: string, accountId: string | null = "page-1") =>
    saveAccount(db, {
      network,
      account: `@${network}`,
      accountId,
      meta: { handle: network },
      userId: user.id,
      tokens: {
        accessToken: `token-${network}`,
        refreshToken: null,
        // Null rather than a date, so nothing in these tests depends on a
        // refresh call reaching the network.
        expiresAt: null,
        scope: null,
        payload: {},
      },
    })

  const addMedia = async (mime: string, filename: string) => {
    const mediaId = id()
    await db.execute(
      from(media).insert({
        id: mediaId,
        filename,
        storage_key: `test/${filename}`,
        url: `/media/file/test/${filename}`,
        mime,
        size: 1024,
        width: 1080,
        height: 1080,
        alt: null,
        caption: null,
        folder: null,
        uploaded_by: user.id,
        created_at: now(),
        deleted_at: null,
      }),
    )
    return mediaId
  }

  return { db, call, connectAccount, addMedia, hooks }
}

const original = globalThis.fetch

afterEach(() => {
  globalThis.fetch = original
})

// Every publisher call in these tests goes through here, so a URL nobody
// stubbed fails loudly rather than reaching the real network.
const stub = (routes: Record<string, () => Response>) => {
  globalThis.fetch = (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const match = Object.keys(routes).find(key => url.includes(key))
    if (!match) throw new Error(`unstubbed request: ${url}`)
    return routes[match]?.()
  }) as typeof fetch

  return globalThis.fetch
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

test("a post is composed with one target per account and starts as a draft", async () => {
  const { call, connectAccount } = await setup()
  const x = await connectAccount("x")

  const response = await call("POST", "/social/posts", {
    title: "Launch day",
    caption: "We shipped it.",
    targets: [{ accountId: x.id }],
  })
  expect(response.status).toBe(201)

  const post = (await response.json()) as { id: string; status: string; targets: { network: string; status: string }[] }
  expect(post.status).toBe("draft")
  expect(post.targets).toHaveLength(1)
  expect(post.targets[0]?.network).toBe("x")
  expect(post.targets[0]?.status).toBe("pending")
})

test("a caption longer than a network takes is refused before it is stored", async () => {
  const { call, connectAccount } = await setup()
  const x = await connectAccount("x")

  const response = await call("POST", "/social/posts", {
    caption: "a".repeat(300),
    targets: [{ accountId: x.id }],
  })

  expect(response.status).toBe(400)
  const body = (await response.json()) as { code: string; details: { fields: { message: string }[] } }
  expect(body.code).toBe("SOCIAL_INVALID")
  expect(body.details.fields[0]?.message).toContain("280")

  // Nothing was written, so the list is still empty.
  const list = (await (await call("GET", "/social/posts")).json()) as { meta: { total: number } }
  expect(list.meta.total).toBe(0)
})

test("a video network refuses a text-only post", async () => {
  const { call, connectAccount } = await setup()
  const tiktok = await connectAccount("tiktok")

  const response = await call("POST", "/social/posts", { caption: "hello", targets: [{ accountId: tiktok.id }] })
  expect(response.status).toBe(400)
  const body = (await response.json()) as { details: { fields: { message: string }[] } }
  expect(body.details.fields.map(field => field.message).join(" ")).toContain("needs a video")
})

test("a post with nowhere to go is refused", async () => {
  const { call } = await setup()
  const response = await call("POST", "/social/posts", { caption: "hello", targets: [] })
  expect(response.status).toBe(400)
})

test("an author writes the post; only an editor sets when it goes out", async () => {
  const author = await setup("author")
  const account = await author.connectAccount("x")

  // The time is dropped rather than the save being refused — an author's job
  // is the copy, and losing it to a permission error would be the wrong lesson.
  const created = (await (
    await author.call("POST", "/social/posts", {
      caption: "written by an author",
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      targets: [{ accountId: account.id }],
    })
  ).json()) as { id: string; status: string; scheduledAt: string | null }

  expect(created.status).toBe("draft")
  expect(created.scheduledAt).toBeNull()

  // And the explicit route is closed to them.
  const refused = await author.call("POST", `/social/posts/${created.id}/schedule`, {
    at: new Date(Date.now() + 3_600_000).toISOString(),
  })
  expect(refused.status).toBe(403)
})

test("scheduling refuses a time that has already passed", async () => {
  const { call, connectAccount } = await setup()
  const account = await connectAccount("x")
  const post = (await (
    await call("POST", "/social/posts", { caption: "hi", targets: [{ accountId: account.id }] })
  ).json()) as { id: string }

  const response = await call("POST", `/social/posts/${post.id}/schedule`, {
    at: new Date(Date.now() - 60_000).toISOString(),
  })
  expect(response.status).toBe(400)
})

test("connecting an account is an admin's job, not an editor's", async () => {
  const editor = await setup("editor")
  expect((await editor.call("GET", "/social/accounts")).status).toBe(403)

  const admin = await setup("admin")
  const response = await admin.call("GET", "/social/accounts")
  expect(response.status).toBe(200)

  const body = (await response.json()) as {
    data: { redirectUri: string; networks: { value: string; configured: boolean }[] }
  }
  expect(body.data.redirectUri).toEndWith("/social/oauth/callback")
  // Nothing sets SOCIAL_OAUTH_*_CLIENT_ID in tests, which is the state a fresh
  // install is in — every network renders as "no app registered".
  expect(body.data.networks.every(network => !network.configured)).toBe(true)
  expect(body.data.networks.map(network => network.value)).toContain("tiktok")
})

test("one network refusing a post does not stop the others, and the post says so", async () => {
  const { call, connectAccount, hooks } = await setup()
  const x = await connectAccount("x")
  const facebook = await connectAccount("facebook")

  const seen: { status: string }[] = []
  hooks.on("social.posted", "test", payload => {
    seen.push({ status: payload.status })
  })

  stub({
    "api.x.com/2/tweets": () => json({ data: { id: "tweet-1" } }),
    "graph.facebook.com": () => json({ error: { message: "(#200) Pages Manage Posts permission is required" } }, 403),
  })

  const post = (await (
    await call("POST", "/social/posts", {
      caption: "goes to two places",
      targets: [{ accountId: x.id }, { accountId: facebook.id }],
    })
  ).json()) as { id: string }

  const result = (await (await call("POST", `/social/posts/${post.id}/publish`)).json()) as {
    data: { status: string }
    post: { status: string; targets: { network: string; status: string; url: string | null; error: string | null }[] }
  }

  expect(result.data.status).toBe("partial")
  expect(result.post.status).toBe("partial")

  const byNetwork = new Map(result.post.targets.map(target => [target.network, target]))
  expect(byNetwork.get("x")?.status).toBe("posted")
  expect(byNetwork.get("x")?.url).toBe("https://x.com/x/status/tweet-1")
  expect(byNetwork.get("facebook")?.status).toBe("failed")
  // The network's own sentence, not a summary of it.
  expect(byNetwork.get("facebook")?.error).toContain("Pages Manage Posts permission")

  expect(seen).toEqual([{ status: "partial" }])
})

test("sending again retries what failed and does not post twice to what worked", async () => {
  const { call, connectAccount } = await setup()
  const x = await connectAccount("x")
  const facebook = await connectAccount("facebook")

  let tweets = 0
  let feeds = 0

  stub({
    "api.x.com/2/tweets": () => {
      tweets += 1
      return json({ data: { id: "tweet-1" } })
    },
    "graph.facebook.com": () => {
      feeds += 1
      return feeds === 1 ? json({ error: { message: "temporary" } }, 500) : json({ id: "page_1_post_9" })
    },
  })

  const post = (await (
    await call("POST", "/social/posts", {
      caption: "twice",
      targets: [{ accountId: x.id }, { accountId: facebook.id }],
    })
  ).json()) as { id: string }

  await call("POST", `/social/posts/${post.id}/publish`)
  const second = (await (await call("POST", `/social/posts/${post.id}/publish`)).json()) as {
    post: { status: string; targets: { network: string; status: string; url: string | null }[] }
  }

  expect(second.post.status).toBe("posted")
  // X was asked exactly once across both runs; Facebook twice.
  expect(tweets).toBe(1)
  expect(feeds).toBe(2)
  expect(second.post.targets.find(target => target.network === "facebook")?.url).toBe(
    "https://www.facebook.com/page_1_post_9",
  )
})

test("the sweep sends what is due and leaves what is not", async () => {
  const { db, call, connectAccount } = await setup()
  const x = await connectAccount("x")

  stub({ "api.x.com/2/tweets": () => json({ data: { id: "tweet-due" } }) })

  const due = (await (
    await call("POST", "/social/posts", { caption: "due now", targets: [{ accountId: x.id }] })
  ).json()) as { id: string }
  const later = (await (
    await call("POST", "/social/posts", { caption: "not yet", targets: [{ accountId: x.id }] })
  ).json()) as { id: string }

  await call("POST", `/social/posts/${due.id}/schedule`, { at: new Date(Date.now() + 1_000).toISOString() })
  await call("POST", `/social/posts/${later.id}/schedule`, { at: new Date(Date.now() + 86_400_000).toISOString() })

  // The one scheduled a second out is now in the past; the other is tomorrow.
  await new Promise(resolve => setTimeout(resolve, 1_100))

  const outcomes = await publishDue(db, store)
  expect(outcomes).toHaveLength(1)
  expect(outcomes[0]?.postId).toBe(due.id)
  expect(outcomes[0]?.status).toBe("posted")

  const stillWaiting = (await (await call("GET", `/social/posts/${later.id}`)).json()) as { status: string }
  expect(stillWaiting.status).toBe("scheduled")
})

test("a post aimed at an account that was disconnected fails that target, not the request", async () => {
  const { db, call, connectAccount } = await setup()
  const x = await connectAccount("x")
  const facebook = await connectAccount("facebook")

  stub({ "api.x.com/2/tweets": () => json({ data: { id: "tweet-1" } }) })

  const post = (await (
    await call("POST", "/social/posts", {
      caption: "one of these is going away",
      targets: [{ accountId: x.id }, { accountId: facebook.id }],
    })
  ).json()) as { id: string }

  // Disconnected after the post was written and before it went out, which is
  // the ordinary way this happens: someone revokes an app on a Friday.
  await removeAccount(db, facebook.id)

  const result = (await (await call("POST", `/social/posts/${post.id}/publish`)).json()) as {
    post: { status: string; targets: { network: string; status: string; error: string | null }[] }
  }

  expect(result.post.status).toBe("partial")
  const orphan = result.post.targets.find(target => target.network === "facebook")
  expect(orphan?.status).toBe("failed")
  expect(orphan?.error).toContain("no longer connected")
  // The row survives its account, so the history still says where this went.
  expect(result.post.targets).toHaveLength(2)
})

test("per-network wording overrides the post's caption without changing it", async () => {
  const { call, connectAccount } = await setup()
  const x = await connectAccount("x")
  const facebook = await connectAccount("facebook")

  const sent: string[] = []
  stub({
    "api.x.com/2/tweets": () => {
      return json({ data: { id: "tweet-1" } })
    },
    "graph.facebook.com": () => json({ id: "page_1_post_1" }),
  })

  // Capture the bodies by wrapping the stub one level up. Decoded, because X
  // sends JSON and Facebook sends a form — and only one of those has the
  // caption in it in a form a string match would find.
  const inner = globalThis.fetch
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    if (init?.body) sent.push(decodeURIComponent(String(init.body).replace(/\+/g, " ")))
    return inner(input as Request, init)
  }) as typeof fetch

  const post = (await (
    await call("POST", "/social/posts", {
      caption: "the long version, for Facebook",
      targets: [{ accountId: facebook.id }, { accountId: x.id, caption: "the short one" }],
    })
  ).json()) as { id: string; caption: string }

  await call("POST", `/social/posts/${post.id}/publish`)

  expect(sent.some(body => body.includes("the short one"))).toBe(true)
  expect(sent.some(body => body.includes("the long version, for Facebook"))).toBe(true)

  // The post itself still holds the caption it was written with.
  const stored = (await (await call("GET", `/social/posts/${post.id}`)).json()) as { caption: string }
  expect(stored.caption).toBe("the long version, for Facebook")
})

test("a network is offered only once its developer app is set up and switched on", async () => {
  const admin = await setup("admin")

  const read = async () =>
    (await (await admin.call("GET", "/social/settings")).json()) as {
      data: {
        redirectUri: string
        preamble: string
        networks: {
          value: string
          ready: boolean
          guide: { steps: unknown[] } | null
          app: { source: string; clientId: string; hasSecret: boolean; secretHint: string | null }
        }[]
      }
    }

  const before = await read()
  expect(before.data.redirectUri).toEndWith("/social/oauth/callback")
  // Nine networks, every one of them with a walkthrough — a settings row whose
  // "?" opened an empty dialog would be worse than no "?" at all.
  expect(before.data.networks).toHaveLength(9)
  expect(before.data.networks.every(network => (network.guide?.steps.length ?? 0) > 0)).toBe(true)
  expect(before.data.networks.every(network => !network.ready)).toBe(true)

  await admin.call("PUT", "/social/settings/x", {
    enabled: true,
    clientId: "client-123",
    clientSecret: "secret-abcd",
  })

  const after = await read()
  const x = after.data.networks.find(network => network.value === "x")
  expect(x?.ready).toBe(true)
  expect(x?.app.source).toBe("admin")
  expect(x?.app.hasSecret).toBe(true)
  expect(x?.app.secretHint).toBe("••••abcd")
  // The secret itself never leaves the server.
  expect(JSON.stringify(after)).not.toContain("secret-abcd")

  // Everything else is still unset, so setting one up does not offer the rest.
  expect(after.data.networks.filter(network => network.ready)).toHaveLength(1)
})

test("switching a network on without a client id is refused", async () => {
  const admin = await setup("admin")
  const response = await admin.call("PUT", "/social/settings/tiktok", { enabled: true, clientId: "  " })

  expect(response.status).toBe(400)
  const body = (await response.json()) as { details: { fields: { key: string }[] } }
  expect(body.details.fields[0]?.key).toBe("clientId")
})

test("only an admin sets a network up", async () => {
  const editor = await setup("editor")
  expect((await editor.call("GET", "/social/settings")).status).toBe(403)
  expect((await editor.call("PUT", "/social/settings/x", { enabled: true, clientId: "no" })).status).toBe(403)
})

test("connecting a network that is not set up says where to go", async () => {
  const admin = await setup("admin")
  const response = await admin.call("POST", "/social/accounts/linkedin/start")

  expect(response.status).toBe(400)
  const body = (await response.json()) as { code: string; error: string }
  expect(body.code).toBe("NO_OAUTH_CLIENT")
  expect(body.error).toContain("Social settings")
})

const ALL = [
  "x",
  "facebook",
  "instagram",
  "threads",
  "linkedin",
  "tiktok",
  "youtube",
  "pinterest",
  "googlebusiness",
] as const

test("every one of the nine networks can be aimed at, and the shapes differ", async () => {
  const { call, connectAccount, addMedia } = await setup()
  const ids: Record<string, string> = {}
  for (const network of ALL) ids[network] = (await connectAccount(network)).id

  const video = await addMedia("video/mp4", "clip.mp4")
  const image = await addMedia("image/jpeg", "still.jpg")
  const target = (network: string) => ({ accountId: ids[network] as string })

  // There is no single post that legally reaches all nine, and that is the
  // point of the per-network rules rather than a gap in them: seven take a bare
  // video, Pinterest insists on a cover beside it, and Google Business takes no
  // video at all. Asserting the real matrix is the only honest version of "all
  // nine work".
  const bareVideo = await call("POST", "/social/posts", {
    caption: "a clip",
    media: [video],
    targets: ["x", "facebook", "instagram", "threads", "linkedin", "tiktok", "youtube"].map(target),
  })
  expect(bareVideo.status).toBe(201)
  expect(((await bareVideo.json()) as { targets: unknown[] }).targets).toHaveLength(7)

  const withCover = await call("POST", "/social/posts", {
    caption: "a pin",
    media: [image, video],
    targets: [target("pinterest")],
  })
  expect(withCover.status).toBe(201)

  const photo = await call("POST", "/social/posts", {
    caption: "open late tonight",
    media: [image],
    targets: [target("googlebusiness")],
  })
  expect(photo.status).toBe(201)

  // And the rules bite the other way round.
  const coverless = await call("POST", "/social/posts", {
    caption: "a pin",
    media: [video],
    targets: [target("pinterest")],
  })
  expect(coverless.status).toBe(400)
  expect(JSON.stringify(await coverless.json())).toContain("cover image")

  const videoToGoogle = await call("POST", "/social/posts", {
    caption: "hi",
    media: [video],
    targets: [target("googlebusiness")],
  })
  expect(videoToGoogle.status).toBe(400)
  expect(JSON.stringify(await videoToGoogle.json())).toContain("does not take video")

  // Only Pinterest means anything by both.
  const both = await call("POST", "/social/posts", {
    caption: "hi",
    media: [image, video],
    targets: [target("x")],
  })
  expect(both.status).toBe(400)
  expect(JSON.stringify(await both.json())).toContain("not both")
})
