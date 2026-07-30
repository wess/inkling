import { secretToken } from "../ids/index.ts"

// A browser cannot set headers on a WebSocket handshake, which leaves the query
// string as the only place to put a credential — and query strings land in
// access logs, proxy logs, and `Referer` headers. So the socket is opened with a
// ticket instead: minted over an already-authenticated request, valid once, and
// dead within seconds. Leaking one buys an attacker nothing.
//
// The store is per-process and deliberately in memory. Tickets live for seconds
// and are consumed by the very next request, so persisting them would add a
// table and a sweep to protect a value that is worthless by the time anything
// could read it. A multi-process deployment needs sticky routing for the
// upgrade request — the same requirement the socket itself already imposes.

const TTL_MS = 30_000

// Not generic: what comes back is the opaque string and its deadline. The payload
// type matters only on the way in and at redemption.
export type Ticket = { readonly value: string; readonly expiresAt: string }

export type TicketStore<T> = {
  readonly issue: (payload: T) => Ticket
  // Redeeming removes the ticket, so a replayed handshake fails.
  readonly redeem: (value: string) => T | null
  readonly size: () => number
}

export const createTicketStore = <T>(ttlMs: number = TTL_MS): TicketStore<T> => {
  const held = new Map<string, { payload: T; expiresAtMs: number }>()

  // Anything expired is already unusable, so this runs opportunistically on
  // issue rather than on a timer — a plugin-style interval would outlive the
  // store it is sweeping.
  const sweep = (nowMs: number) => {
    for (const [key, entry] of held) if (entry.expiresAtMs <= nowMs) held.delete(key)
  }

  return {
    issue: payload => {
      const nowMs = Date.now()
      sweep(nowMs)
      const value = secretToken("inkrt")
      const expiresAtMs = nowMs + ttlMs
      held.set(value, { payload, expiresAtMs })
      return { value, expiresAt: new Date(expiresAtMs).toISOString() }
    },

    redeem: value => {
      const entry = held.get(value)
      if (!entry) return null
      held.delete(value)
      return entry.expiresAtMs <= Date.now() ? null : entry.payload
    },

    size: () => held.size,
  }
}
