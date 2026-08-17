import type { Connection } from "atlas/db"
import type { Route } from "atlas/server"
import { get, json, pipeline, post } from "atlas/server"
import type { WsConn } from "atlas/server/ws"
import { createRooms, ws as createWs } from "atlas/server/ws"
import type { Server, ServerWebSocket } from "bun"
import { auth, requireAuth, requireCan, requireHuman } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { corsAll, noStore } from "../http/index.ts"
import { keyIdentity, requireApiKey } from "../keys/index.ts"
import type { Hooks } from "../plugins/hooks.ts"
import { now } from "../time/index.ts"
import { createTicketStore } from "./tickets.ts"
import type { Audience, Envelope, Topic, Viewer } from "./topics.ts"
import { contentTopic, entryTopic, maySubscribe, readInbound, SITE_TOPIC, shapeFor, viewerOf } from "./topics.ts"

// Live updates over one socket per client. Two things needed this: the admin
// showing stale lists whenever two people worked at once, and consuming sites
// having no way to learn that published content changed short of polling the
// delivery API on a timer.
//
// The socket adds no authority. A session sees what its role already permits; a
// delivery key hears only that published content moved, with the same scope
// checks the HTTP surface applies. Payloads never carry an entry's `data` — a
// notification says *what* changed, and the consumer re-reads it through the API
// where the boundary is enforced on the way out.

// What rides on each socket. Exported because Bun infers `Server<T>` from the
// websocket handlers' data type, and `server.upgrade(req, { data })` only
// type-checks when the two agree.
export type SocketState = {
  readonly audience: Audience
  readonly topics: Set<Topic>
  readonly connectedAt: string
}

export type Realtime = {
  // Session-gated; mounted under /api with the rest of the admin surface.
  readonly routes: Route[]
  // Key-authenticated or unauthenticated; stays at the root of the origin
  // because consuming sites call it.
  readonly publicRoutes: Route[]
  // Handed to Bun.serve. The upgrade has to be attempted in `fetch` before the
  // router runs, so src/server.ts calls `upgrade` itself.
  readonly websocket: {
    open: (ws: ServerWebSocket<SocketState>) => void
    message: (ws: ServerWebSocket<SocketState>, message: string | Buffer) => void
    close: (ws: ServerWebSocket<SocketState>, code: number, reason: string) => void
  }
  readonly upgrade: (request: Request, server: Server<SocketState>) => boolean
  readonly publish: (envelope: Envelope) => void
  readonly register: (hooks: Hooks) => void
  readonly stats: () => { sockets: number; topics: number }
}

export const createRealtime = (db: Connection): Realtime => {
  const rooms = createRooms()
  const tickets = createTicketStore<Audience>()
  const sockets = new Set<WsConn<SocketState>>()

  const stateOf = (socket: WsConn<SocketState>): SocketState => socket.data

  // Per-audience shaping means this can't be rooms.broadcast(), which sends one
  // payload to every member. A key holder and an editor can share a topic and
  // must not receive the same frame.
  const publish = (envelope: Envelope): void => {
    for (const socket of rooms.members(envelope.topic)) {
      const typed = socket as WsConn<SocketState>
      const shaped = shapeFor(stateOf(typed).audience, envelope)
      if (!shaped) continue
      try {
        typed.send(shaped)
      } catch {
        // A socket that closed between membership lookup and send is not an
        // error worth surfacing; `close` will clean up its rooms.
      }
    }
  }

  // Everyone currently looking at an entry, minus one. `exclude` is how a
  // departing socket announces the room it is leaving without counting itself.
  const viewersOf = (topic: Topic, exclude?: WsConn<SocketState>): Viewer[] => {
    const seen = new Map<string, Viewer>()
    for (const socket of rooms.members(topic)) {
      const typed = socket as WsConn<SocketState>
      if (typed === exclude) continue
      const viewer = viewerOf(stateOf(typed).audience)
      // Keyed by user id, so two browser tabs are one person in the list.
      if (viewer) seen.set(viewer.id, viewer)
    }
    return [...seen.values()]
  }

  const announcePresence = (topic: Topic, exclude?: WsConn<SocketState>): void => {
    if (!topic.startsWith("entry:")) return
    publish({ topic, event: "presence", data: { viewers: viewersOf(topic, exclude) } })
  }

  const { websocket, upgrade } = createWs({
    onOpen: incoming => {
      const socket = incoming as WsConn<SocketState>
      sockets.add(socket)
      socket.send({ event: "ready", data: { at: now(), audience: stateOf(socket).audience.kind } })
    },

    onMessage: (incoming, message) => {
      const socket = incoming as WsConn<SocketState>
      const frame = readInbound(typeof message === "string" ? message : message.toString())
      if (!frame) {
        socket.send({ event: "error", data: { message: "Unrecognized frame" } })
        return
      }

      if (frame.action === "ping") {
        socket.send({ event: "pong", data: { at: now() } })
        return
      }

      const state = stateOf(socket)

      if (frame.action === "unsubscribe") {
        if (!state.topics.delete(frame.topic)) return
        rooms.leave(socket, frame.topic)
        announcePresence(frame.topic, socket)
        socket.send({ event: "unsubscribed", data: { topic: frame.topic } })
        return
      }

      if (!maySubscribe(state.audience, frame.topic)) {
        socket.send({ event: "error", data: { topic: frame.topic, message: "Not permitted for this credential" } })
        return
      }

      // A client that resubscribes on reconnect shouldn't accumulate rooms.
      if (state.topics.has(frame.topic)) return
      // Bounded so one socket can't be used to enumerate or hoard rooms.
      if (state.topics.size >= 64) {
        socket.send({ event: "error", data: { message: "Too many subscriptions on one socket" } })
        return
      }

      state.topics.add(frame.topic)
      rooms.join(socket, frame.topic)
      socket.send({ event: "subscribed", data: { topic: frame.topic } })
      announcePresence(frame.topic)
    },

    // Runs before the room manager drops the socket, so the departing viewer is
    // still a member and has to be excluded explicitly.
    onClose: incoming => {
      const socket = incoming as WsConn<SocketState>
      sockets.delete(socket)
      for (const topic of stateOf(socket).topics) announcePresence(topic, socket)
    },
  })

  const register = (hooks: Hooks): void => {
    const entryEvent =
      (event: string) => (payload: { entry: { id: string; slug: string }; type: { name: string } | null }) => {
        const data = { id: payload.entry.id, slug: payload.entry.slug, type: payload.type?.name ?? null }
        if (payload.type) publish({ topic: contentTopic(payload.type.name), event, data })
        publish({ topic: entryTopic(payload.entry.id), event, data })
      }

    hooks.on("entry.afterSave", "core", ({ entry, type, created }) =>
      entryEvent(created ? "entry.created" : "entry.updated")({ entry, type }),
    )
    hooks.on("entry.afterPublish", "core", ({ entry, type }) => entryEvent("entry.published")({ entry, type }))
    hooks.on("entry.afterUnpublish", "core", ({ entry, type }) => entryEvent("entry.unpublished")({ entry, type }))
    hooks.on("entry.afterDelete", "core", ({ entry }) => entryEvent("entry.deleted")({ entry, type: null }))

    // Media and site-level changes are instance-wide rather than per-type.
    hooks.on("media.afterUpload", "core", ({ media }) =>
      publish({ topic: SITE_TOPIC, event: "media.uploaded", data: { id: media.id, filename: media.filename } }),
    )
    hooks.on("media.afterDelete", "core", ({ media }) =>
      publish({ topic: SITE_TOPIC, event: "media.deleted", data: { id: media.id } }),
    )
  }

  const ticketRoutes: Route[] = [
    // Session holders: the admin. Mounted under /api, so the admin reaches this
    // at /api/realtime/ticket like every other call it makes.
    //
    // People only. A session-audience socket receives every frame unshaped —
    // drafts moving, bylines changing, who is looking at what — and that is a
    // strictly wider view than any grant a machine credential can hold, so an
    // agent key here would be a way around its own scopes.
    post(
      "/realtime/ticket",
      pipeline(
        requireAuth(db),
        requireHuman,
      )(async c => {
        const ticket = tickets.issue({ kind: "session", identity: auth(c) })
        return json(noStore(c), 201, { ticket: ticket.value, expiresAt: ticket.expiresAt, url: "/realtime" })
      }),
    ),

    get(
      "/realtime/stats",
      pipeline(
        requireAuth(db),
        requireCan(can.manageSettings, "view realtime status"),
      )(async c => {
        const counts = realtime.stats()
        return json(noStore(c), 200, { data: { ...counts, pendingTickets: tickets.size() } })
      }),
    ),
  ]

  const publicTicketRoutes: Route[] = [
    // Key holders: a consuming site that wants invalidation without polling.
    // Deliberately mirrors the delivery surface's auth rather than inventing a
    // third credential, and stays at the root for the same reason /content does.
    post(
      "/realtime/delivery/ticket",
      pipeline(
        corsAll,
        requireApiKey(db),
      )(async c => {
        const ticket = tickets.issue({ kind: "key", identity: keyIdentity(c) })
        return json(noStore(c), 201, { ticket: ticket.value, expiresAt: ticket.expiresAt, url: "/realtime" })
      }),
    ),
  ]

  const realtime: Realtime = {
    routes: ticketRoutes,
    publicRoutes: publicTicketRoutes,
    websocket: websocket as Realtime["websocket"],

    // Returning false lets src/server.ts fall through to the router, so a bad
    // ticket gets an ordinary 404 rather than a half-open socket.
    upgrade: (request, server) => {
      const url = new URL(request.url)
      if (url.pathname !== "/realtime") return false

      const audience = tickets.redeem(url.searchParams.get("ticket") ?? "")
      if (!audience) return false

      const state: SocketState = { audience, topics: new Set(), connectedAt: now() }
      return upgrade(request, server, state)
    },

    publish,
    register,
    stats: () => ({ sockets: sockets.size, topics: new Set([...sockets].flatMap(s => [...stateOf(s).topics])).size }),
  }

  return realtime
}

export type { Audience, Envelope, Topic, Viewer } from "./topics.ts"
export { contentTopic, entryTopic, SITE_TOPIC } from "./topics.ts"
