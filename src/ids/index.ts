// Every primary key in Inkling is a UUID string rather than a serial. Two
// reasons: it is the one PK spelling that is identical on Postgres and SQLite,
// and it lets content be exported from one environment and imported into
// another without renumbering every foreign key.

export const id = (): string => crypto.randomUUID()

// Prefixed opaque tokens (API keys, share tokens). 32 bytes of base64url.
export const secretToken = (prefix: string): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const body = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return `${prefix}_${body}`
}

export const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
}

const RESERVED = new Set(["new", "edit", "api", "admin", "index"])

export const slugify = (input: string): string => {
  const base = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
  if (!base) return id().slice(0, 8)
  return RESERVED.has(base) ? `${base}-1` : base
}

// Content-type, taxonomy, and menu names become URL segments in the delivery
// API (`/content/:type`), where mixed case is a portability hazard — some
// proxies and filesystems fold it. So those stay strictly lowercase.
const HANDLE = /^[a-z][a-z0-9]*$/

export const isHandle = (value: string): boolean => value.length <= 48 && HANDLE.test(value)

// Field keys only ever appear as JSON keys inside an entry's `data`, never in a
// URL, so camelCase is allowed — it is what a consuming template naturally
// wants to write (`page.heroHeading`, not `page.heroheading`).
const FIELD_KEY = /^[a-z][a-zA-Z0-9]*$/

export const isFieldKey = (value: string): boolean => value.length <= 48 && FIELD_KEY.test(value)
