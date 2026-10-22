# Inkling delivery API

The delivery API is the read-only surface a website uses to render published
content. It uses a delivery key beginning with `ink_`; session tokens and agent
keys are refused.

## Authentication

Send the key in `X-Api-Key` on every request. Create it under **API keys** in the
admin and scope it to only the content types the consuming site needs.

```sh
curl -H 'X-Api-Key: ink_…' https://cms.example.com/content/post
```

Never ship a delivery key in public browser code. Call Inkling from the
consuming site's server or build process.

## Routes

| Route | Result |
|---|---|
| `GET /content` | Content types visible to this key, including field shapes |
| `GET /content/:type` | A page of published entries |
| `GET /content/:type/:slug` | One published collection entry |
| `GET /content/:type/single` | The published entry for a single type |
| `GET /site/settings` | Public site settings, with media expanded |
| `GET /site/menus/:name` | One public menu tree |
| `GET /preview/:token` | The entry named by a short-lived preview token |
| `POST /realtime/delivery/ticket` | A 30-second, single-use socket ticket |

Collection queries accept:

- `page` and `limit` for paging;
- `term` for a taxonomy term slug;
- `locale` for an exact locale;
- `sort` for the documented ordering;
- `include=terms,author` for those related records.

The response envelope is:

```json
{
  "data": [],
  "meta": { "total": 0, "page": 1, "limit": 20 }
}
```

Do not treat one page as the full collection. Use `meta.total`, `meta.page`, and
`meta.limit` to decide whether another request is needed.

## Content shape

Rows and internal SQL names never leak through the API. Response properties are
camelCase, and model-specific values live in each entry's `data` object.

Media fields are expanded to media objects. Reference fields are expanded to
published entries that the same key could fetch directly. If a referenced entry
is unpublished or outside the key's type scopes, it is omitted rather than
leaked through the parent.

## Complete fetch example

```ts
type DeliveryPage<T> = {
  data: T[]
  meta: { total: number; page: number; limit: number }
}

const cms = new URL(process.env.INKLING_URL as string)
const key = process.env.INKLING_KEY as string

const get = async <T>(path: string): Promise<T> => {
  const response = await fetch(new URL(path, cms), {
    headers: { "X-Api-Key": key },
  })
  if (!response.ok) throw new Error(`Inkling ${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}

const posts = await get<DeliveryPage<{ slug: string; title: string; data: unknown }>>(
  "/content/post?limit=100&include=terms,author",
)
```

## Caching

Authenticated delivery responses are private-cacheable and vary on
`X-Api-Key`. Keep them in a server-side or build cache, never a shared public
cache keyed only by URL. Published content changes can invalidate that cache in
realtime.

Embedded hosts can compare `inkling.contentVersion()` before using an in-memory
delivery cache and clear the cache when it changes. Do not let an older in-flight
read refill a cache after a save. This counter is local to the running process;
remote consumers use the realtime channel below. Public HTML should revalidate
after edits, for example with `Cache-Control: public, max-age=0, must-revalidate`.

Public media responses explicitly allow cross-origin embedding. Hashed admin
assets are unrelated to delivery content and may be cached immutably.

## Realtime invalidation

Exchange the delivery key for a ticket:

```sh
curl -X POST -H 'X-Api-Key: ink_…' \
  https://cms.example.com/realtime/delivery/ticket
```

Open `wss://cms.example.com/realtime?ticket=…` before the ticket expires, then
subscribe with:

```json
{ "action": "subscribe", "topic": "content:post" }
```

Delivery keys may subscribe to `site` and to `content:<type>` for types within
their scopes. They cannot subscribe to entry-presence topics. Change frames
carry ids and slugs, not content; re-read the delivery API when one arrives.

## Preview snapshots

An authenticated editor may send `{ title, slug, data }` to
`POST /api/entries/:id/preview` to preview unsaved changes. An empty request body
previews the saved entry instead. The response includes `url`, `siteUrl`, `token`,
and `expiresAt`. Both link types authorize one entry for up to an hour; unsaved
snapshots also expire on server restart or eviction from the bounded preview
store. They do not save or publish changes.

Fetch `/preview/:token` on the site's server and substitute that entry only for
the current request. Never cache preview content publicly. Send `no-store` and
`X-Robots-Tag: noindex, nofollow` on the rendered page. Media expands normally;
references do not expand into other drafts.

## Errors

API errors use a stable JSON body:

```json
{ "error": "Human-readable message", "code": "stable_code" }
```

A 401 means the key is missing or invalid. A 403 means it is valid but the type
is outside its scopes. A 404 may mean the record does not exist, is unpublished,
or is deliberately hidden from this key. Do not use previews as a general draft
API: each preview token identifies one entry and expires after an hour.
