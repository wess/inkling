import type { Identity } from "../auth/guard.ts"
import type { ContentTypeRow } from "../contenttypes/index.ts"
import type { EntryRow } from "../entries/index.ts"
import type { MediaRow } from "../media/index.ts"

// Two shapes of extension point:
//
//   emit   — notification. Every listener runs, failures are isolated and
//            logged, the core path never fails because a plugin threw.
//   filter — transformation. Listeners run in registration order, each
//            receiving the previous one's output. A listener that throws is
//            skipped and its input carries forward, so a broken plugin
//            degrades to a no-op instead of blocking a save.
//
// The distinction matters: a plugin should be able to *observe* anything
// without being able to break it, and *change* things only where the core
// explicitly offers a filter.

export type EmitMap = {
  "entry.afterSave": { entry: EntryRow; type: ContentTypeRow | null; identity: Identity | null; created: boolean }
  "entry.beforePublish": { entry: EntryRow; type: ContentTypeRow | null; identity: Identity | null }
  "entry.afterPublish": { entry: EntryRow; type: ContentTypeRow | null; identity: Identity | null }
  "entry.afterUnpublish": { entry: EntryRow; type: ContentTypeRow | null; identity: Identity | null }
  "entry.afterDelete": { entry: EntryRow; identity: Identity | null }
  "media.afterUpload": { media: MediaRow; identity: Identity | null }
  "media.afterDelete": { media: MediaRow; identity: Identity | null }
  // After a social post has been attempted on every network it names. There is
  // no `before` half and there will not be: by the time anything could listen,
  // the post is on someone else's servers and no listener can take it back.
  "social.posted": {
    id: string
    title: string
    status: string
    targets: { id: string; network: string; status: string; error: string | null }[]
  }
  "server.ready": { at: string }
}

export type FilterMap = {
  // Last chance to adjust an entry before it is written.
  "entry.beforeSave": { entry: EntryRow; type: ContentTypeRow; identity: Identity | null }
  // Shape what the public delivery API returns for one entry.
  "delivery.entry": { payload: Record<string, unknown>; type: ContentTypeRow; raw: EntryRow }
}

export type EmitName = keyof EmitMap
export type FilterName = keyof FilterMap

type Listener = { readonly plugin: string; readonly fn: (payload: any) => unknown }

export type Hooks = {
  readonly on: <K extends EmitName>(name: K, plugin: string, fn: (payload: EmitMap[K]) => void | Promise<void>) => void
  readonly addFilter: <K extends FilterName>(
    name: K,
    plugin: string,
    fn: (payload: FilterMap[K]) => FilterMap[K] | Promise<FilterMap[K]>,
  ) => void
  readonly emit: <K extends EmitName>(name: K, payload: EmitMap[K]) => Promise<void>
  readonly filter: <K extends FilterName>(name: K, payload: FilterMap[K]) => Promise<FilterMap[K]>
  readonly removePlugin: (plugin: string) => void
  readonly clearPlugins: () => void
  readonly clear: () => void
  readonly listenerCount: (name: EmitName | FilterName) => number
}

export const createHooks = (log: (message: string) => void = console.error): Hooks => {
  const emitters = new Map<string, Listener[]>()
  const filters = new Map<string, Listener[]>()

  const push = (map: Map<string, Listener[]>, name: string, listener: Listener) => {
    const current = map.get(name) ?? []
    map.set(name, [...current, listener])
  }

  return {
    on: (name, plugin, fn) => push(emitters, name, { plugin, fn: fn as (p: any) => unknown }),

    addFilter: (name, plugin, fn) => push(filters, name, { plugin, fn: fn as (p: any) => unknown }),

    emit: async (name, payload) => {
      for (const listener of emitters.get(name) ?? []) {
        try {
          await listener.fn(payload)
        } catch (error) {
          log(`[plugin:${listener.plugin}] hook "${name}" failed: ${(error as Error).message}`)
        }
      }
    },

    filter: async (name, payload) => {
      let current = payload
      for (const listener of filters.get(name) ?? []) {
        try {
          const next = await listener.fn(current)
          if (next) current = next as typeof payload
        } catch (error) {
          log(`[plugin:${listener.plugin}] filter "${name}" failed, skipped: ${(error as Error).message}`)
        }
      }
      return current
    },

    removePlugin: plugin => {
      for (const map of [emitters, filters]) {
        for (const [name, listeners] of map.entries()) {
          map.set(
            name,
            listeners.filter(l => l.plugin !== plugin),
          )
        }
      }
    },

    // Registry reloads rebuild plugin listeners, but the core webhook bridge
    // shares this bus and must survive those reloads.
    clearPlugins: () => {
      for (const map of [emitters, filters]) {
        for (const [name, listeners] of map.entries()) {
          map.set(
            name,
            listeners.filter(listener => listener.plugin === "core"),
          )
        }
      }
    },

    clear: () => {
      emitters.clear()
      filters.clear()
    },

    listenerCount: name => (emitters.get(name)?.length ?? 0) + (filters.get(name)?.length ?? 0),
  }
}
