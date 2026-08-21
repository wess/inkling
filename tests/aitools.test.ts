import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import type { Proposal } from "../src/ai/tools/index.ts"
import { runTool } from "../src/ai/tools/index.ts"
import { id } from "../src/ids/index.ts"
import { up } from "../src/migrate/index.ts"
import type { Registry } from "../src/plugins/index.ts"
import { apiKeys, media, menus, taxonomies, terms, users, webhooks } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"
import { noPlugins } from "./fixtures/registry.ts"

// Inky's reach past content: categories, files, navigation, people, the keys a
// website reads with, the webhooks that tell other systems, plugins, and the
// social setup. The property under test is the same one as in aiagent.test.ts —
// every one of these is inert until a person applies it — restated here because
// each new surface is a new chance to get it wrong.

const setup = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")

  const taxonomyId = id()
  await db.execute(
    from(taxonomies).insert({
      id: taxonomyId,
      name: "category",
      label: "Categories",
      hierarchical: 1,
      owner_plugin: null,
      created_at: now(),
    }),
  )
  const termId = id()
  await db.execute(
    from(terms).insert({
      id: termId,
      taxonomy_id: taxonomyId,
      parent_id: null,
      slug: "news",
      label: "News",
      description: null,
      sort_order: 0,
      created_at: now(),
    }),
  )

  const mediaId = id()
  await db.execute(
    from(media).insert({
      id: mediaId,
      filename: "storefront.jpg",
      storage_key: "storefront.jpg",
      url: "/media/file/storefront.jpg",
      mime: "image/jpeg",
      size: 1024,
      width: 800,
      height: 600,
      alt: null,
      caption: null,
      folder: null,
      uploaded_by: null,
      created_at: now(),
      deleted_at: null,
    }),
  )

  await db.execute(
    from(menus).insert({
      id: id(),
      name: "main",
      label: "Main",
      items: JSON.stringify([{ label: "Home", url: "/" }]),
      created_at: now(),
      updated_at: now(),
    }),
  )

  const userId = id()
  await db.execute(
    from(users).insert({
      id: userId,
      email: "designer@example.com",
      name: "Designer",
      password_hash: "x",
      role: "author",
      avatar_id: null,
      created_at: now(),
      updated_at: now(),
      last_seen_at: null,
      deleted_at: null,
    }),
  )

  return { db, taxonomyId, termId, mediaId, userId }
}

const call = (
  db: Awaited<ReturnType<typeof setup>>["db"],
  proposals: Proposal[],
  name: string,
  input: object,
  registry: Registry = noPlugins,
) => runTool({ db, registry, role: "owner", proposals }, name, input as Record<string, unknown>)

test("categories are readable, and changing them is still only a proposal", async () => {
  const { db, termId } = await setup()
  const proposals: Proposal[] = []

  const listed = (await call(db, proposals, "list_taxonomies", {})).output as {
    name: string
    terms: { id: string; label: string }[]
  }[]
  expect(listed[0]?.name).toBe("category")
  expect(listed[0]?.terms[0]?.label).toBe("News")

  await call(db, proposals, "propose_term_create", {
    taxonomy: "category",
    label: "Announcements",
    summary: "Somewhere for the short ones",
  })
  expect(proposals[0]?.kind).toBe("term.create")
  expect(proposals[0]?.needs).toBe("taxonomy.manage")

  // Nothing was written. The term the tool named still does not exist.
  const stored = await db.all<{ id: string }>(from(terms))
  expect(stored).toHaveLength(1)
  expect(stored[0]?.id).toBe(termId)

  // A taxonomy the model invented comes back as a correctable error.
  const missing = await call(db, proposals, "propose_term_create", { taxonomy: "ghost", label: "x", summary: "x" })
  expect(missing.isError).toBe(true)
  expect(proposals).toHaveLength(1)

  await db.close()
})

test("filing a page under a term checks the terms exist before queueing", async () => {
  const { db, termId } = await setup()
  const proposals: Proposal[] = []

  // No entry: the tool has to fail on the entry, not on the terms.
  const noEntry = await call(db, proposals, "propose_entry_terms", {
    entryId: "nope",
    termIds: [termId],
    summary: "x",
  })
  expect(noEntry.isError).toBe(true)
  expect(proposals).toHaveLength(0)

  await db.close()
})

test("alt text can be proposed for a file, and the row does not move", async () => {
  const { db, mediaId } = await setup()
  const proposals: Proposal[] = []

  const files = (await call(db, proposals, "list_media", {})).output as { id: string; alt: string | null }[]
  expect(files[0]?.alt).toBeNull()

  await call(db, proposals, "propose_media_update", {
    mediaId,
    alt: "The shop front on a bright morning",
    summary: "Describe the storefront photo",
  })
  const proposal = proposals[0]
  if (proposal?.kind !== "media.update") throw new Error("unreachable")
  expect(proposal.patch.alt).toBe("The shop front on a bright morning")
  expect(proposal.before.alt).toBeNull()

  const row = await db.one<{ alt: string | null }>(from(media).where(q => q("id").equals(mediaId)))
  expect(row?.alt).toBeNull()

  await db.close()
})

test("a menu can be added and removed, and a bad link is caught in both", async () => {
  const { db } = await setup()
  const proposals: Proposal[] = []

  const refused = await call(db, proposals, "propose_menu_create", {
    label: "Footer",
    summary: "Add a footer menu",
    items: [{ label: "Bad", url: "javascript:alert(1)" }],
  })
  expect(refused.isError).toBe(true)
  expect(proposals).toHaveLength(0)

  await call(db, proposals, "propose_menu_create", {
    label: "Footer",
    summary: "Add a footer menu",
    items: [{ label: "Privacy", url: "/privacy" }],
  })
  await call(db, proposals, "propose_menu_delete", { name: "main", summary: "Retire the old main menu" })
  expect(proposals.map(p => p.kind)).toEqual(["menu.create", "menu.delete"])

  // Still one menu, still called main.
  const rows = await db.all<{ name: string }>(from(menus))
  expect(rows.map(row => row.name)).toEqual(["main"])

  await db.close()
})

test("a delivery key is proposed rather than minted, and its reach is checked first", async () => {
  const { db } = await setup()
  const proposals: Proposal[] = []

  const bad = await call(db, proposals, "propose_delivery_key", {
    name: "marketing site",
    contentTypes: ["ghost"],
    summary: "x",
  })
  expect(bad.isError).toBe(true)
  expect(JSON.stringify(bad.output)).toContain("ghost")

  await call(db, proposals, "propose_delivery_key", { name: "marketing site", summary: "For the new site" })
  const proposal = proposals[0]
  if (proposal?.kind !== "key.create") throw new Error("unreachable")
  expect(proposal.payload.name).toBe("marketing site")
  expect(proposal.needs).toBe("keys.manage")

  // No key exists. The secret is minted by the route, on apply, and shown once.
  expect(await db.all(from(apiKeys))).toHaveLength(0)

  await db.close()
})

test("a webhook pointing somewhere unreachable is refused while the model can fix it", async () => {
  const { db } = await setup()
  const proposals: Proposal[] = []

  const refused = await call(db, proposals, "propose_webhook_create", {
    name: "build hook",
    url: "not a url",
    events: ["entry.published"],
    summary: "x",
  })
  expect(refused.isError).toBe(true)

  const unknownEvent = await call(db, proposals, "propose_webhook_create", {
    name: "build hook",
    url: "https://example.com/hook",
    events: ["entry.exploded"],
    summary: "x",
  })
  expect(unknownEvent.isError).toBe(true)
  expect(proposals).toHaveLength(0)
  expect(await db.all(from(webhooks))).toHaveLength(0)

  await db.close()
})

test("a role change is proposed, and cannot reach above the person asking", async () => {
  const { db, userId } = await setup()
  const proposals: Proposal[] = []

  const people = (await call(db, proposals, "list_people", {})).output as { people: { id: string; role: string }[] }
  expect(people.people.some(person => person.id === userId)).toBe(true)

  await call(db, proposals, "propose_person_role", { userId, role: "editor", summary: "They publish now" })
  const proposal = proposals[0]
  if (proposal?.kind !== "person.role") throw new Error("unreachable")
  expect(proposal.from).toBe("author")
  expect(proposal.to).toBe("editor")

  // An admin cannot mint an owner, and the tool says so rather than letting the
  // route refuse it after the button is pressed.
  const overreach = await runTool({ db, registry: noPlugins, role: "admin", proposals }, "propose_person_role", {
    userId,
    role: "owner",
    summary: "x",
  })
  expect(overreach.isError).toBe(true)
  expect(proposals).toHaveLength(1)

  const row = await db.one<{ role: string }>(from(users).where(q => q("id").equals(userId)))
  expect(row?.role).toBe("author")

  await db.close()
})

test("the social setup reads as three states, and setting one up is a proposal", async () => {
  const { db } = await setup()
  const proposals: Proposal[] = []

  const setup_ = (await call(db, proposals, "get_social_setup", {})).output as {
    redirectUri: string
    networks: { network: string; hasApp: boolean; ready: boolean; accounts: unknown[] }[]
  }
  // The redirect URI is quoted into a developer console character for
  // character, so it comes from here rather than being reassembled.
  expect(setup_.redirectUri).toContain("/social/oauth/callback")
  const x = setup_.networks.find(network => network.network === "x")
  expect(x?.hasApp).toBe(false)
  expect(x?.ready).toBe(false)
  expect(x?.accounts).toHaveLength(0)

  const guide = (await call(db, proposals, "get_social_guide", { network: "x" })).output as {
    steps: unknown[]
    gotchas: unknown[]
  }
  expect(guide.steps.length).toBeGreaterThan(0)
  expect(guide.gotchas.length).toBeGreaterThan(0)

  const unknown = await call(db, proposals, "get_social_guide", { network: "myspace" })
  expect(unknown.isError).toBe(true)

  await call(db, proposals, "propose_social_app", {
    network: "x",
    clientId: "abc123",
    clientSecret: "shhh",
    summary: "Set up X",
  })
  const proposal = proposals[0]
  if (proposal?.kind !== "social.app") throw new Error("unreachable")
  expect(proposal.patch.clientId).toBe("abc123")
  // The secret rides along so applying it is one press; the admin masks it in
  // the diff rather than the tool dropping it.
  expect(proposal.patch.clientSecret).toBe("shhh")
  expect(proposal.before.hasSecret).toBe(false)

  await db.close()
})

test("a social post cannot target an account that is not connected", async () => {
  const { db } = await setup()
  const proposals: Proposal[] = []

  const refused = await call(db, proposals, "propose_social_post", {
    caption: "We are open",
    targets: [{ accountId: "made-up" }],
    summary: "x",
  })
  expect(refused.isError).toBe(true)
  expect(JSON.stringify(refused.output)).toContain("made-up")

  const noTargets = await call(db, proposals, "propose_social_post", {
    caption: "We are open",
    targets: [],
    summary: "x",
  })
  expect(noTargets.isError).toBe(true)
  expect(proposals).toHaveLength(0)

  await db.close()
})

test("plugins are readable and switchable, and an invented setting is refused", async () => {
  const { db } = await setup()
  const proposals: Proposal[] = []

  const registry: Registry = {
    ...noPlugins,
    all: () => [
      {
        plugin: {
          name: "seo",
          label: "SEO",
          version: "1.0.0",
          settings: [{ key: "titleSuffix", label: "Title suffix", type: "text" as const, default: "" }],
        },
        dir: "/plugins/seo",
        enabled: false,
        installedVersion: null,
      },
    ],
    get: name => registry.all().find(entry => entry.plugin.name === name),
  }

  const listed = (await call(db, proposals, "list_plugins", {}, registry)).output as {
    name: string
    enabled: boolean
    settings: { key: string; value: unknown }[]
  }[]
  expect(listed[0]?.name).toBe("seo")
  expect(listed[0]?.enabled).toBe(false)
  expect(listed[0]?.settings[0]?.key).toBe("titleSuffix")

  await call(db, proposals, "propose_plugin_state", { name: "seo", enabled: true, summary: "Turn SEO on" }, registry)
  expect(proposals[0]?.kind).toBe("plugin.state")

  const madeUp = await call(
    db,
    proposals,
    "propose_plugin_settings",
    { name: "seo", settings: { colour: "blue" }, summary: "x" },
    registry,
  )
  expect(madeUp.isError).toBe(true)
  expect(JSON.stringify(madeUp.output)).toContain("titleSuffix")
  expect(proposals).toHaveLength(1)

  await db.close()
})

test("Inky moves the admin, and cannot move it somewhere that does not exist", async () => {
  const { db } = await setup()
  const proposals: Proposal[] = []

  const invented = await call(db, proposals, "open_screen", {
    screen: "billing",
    label: "Open billing",
    why: "to pay the invoice",
  })
  expect(invented.isError).toBe(true)
  expect(proposals).toHaveLength(0)

  // A screen that takes a content type is refused without one, rather than
  // routing to a blank list.
  const noType = await call(db, proposals, "open_screen", { screen: "collection", label: "Open pages", why: "x" })
  expect(noType.isError).toBe(true)

  await call(db, proposals, "open_screen", {
    screen: "socialaccounts",
    label: "Connect Instagram",
    why: "the Connect button is here",
  })
  const proposal = proposals[0]
  if (proposal?.kind !== "admin.open") throw new Error("unreachable")
  expect(proposal.screen).toBe("socialaccounts")
  expect(proposal.label).toBe("Connect Instagram")
  // Reading the admin is all it needs — moving somebody is not a change.
  expect(proposal.needs).toBe("content.read")

  await db.close()
})
