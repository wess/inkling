import type { Connection, SqlResult } from "@atlas/db"
import { raw } from "@atlas/db"

// Postgres has ILIKE; SQLite does not. Both agree on LOWER(col) LIKE pattern,
// and SQLite's LIKE is already ASCII-case-insensitive, so lowering the pattern
// is the portable spelling of "case-insensitive contains".
export const contains = (db: Connection, column: string, term: string) =>
  db.dialect === "postgres"
    ? raw(`${column} ILIKE $1`, `%${term}%`)
    : raw(`LOWER(${column}) LIKE $1`, `%${term.toLowerCase()}%`)

// LIKE treats % and _ as wildcards, so a literal needle has to escape them (and
// the escape character itself) or a value containing one would silently widen
// the match. Both dialects accept the same ESCAPE clause.
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, match => `\\${match}`)

// Literal-substring predicate for *machine* values — an id embedded in a TEXT
// column holding JSON. Distinct from `contains` above, which powers user-facing
// search and is deliberately case-insensitive: this stays case-sensitive so the
// database can use it as a cheap, highly selective prefilter before anything is
// parsed in application memory.
export const embeds = (column: string, literal: string) =>
  raw(`${column} LIKE $1 ESCAPE '\\'`, `%${escapeLike(literal)}%`)

export type AnyQuery = { readonly toSql: (dialect?: never) => SqlResult<unknown> }

// `from(schema)` narrows .select() to the schema's own columns, so aggregates
// and joins must use Atlas's string-table form — `from("entries", "e")`. That
// form then infers the row type from the literal select list, making
// `COUNT(*) as total` an object key rather than the shape the caller wants.
//
// These two helpers are the single boundary where that inference is dropped and
// the intended row type is reattached. Doing it here, once, keeps every call
// site honest about what it expects instead of spreading casts through the
// route modules.
export const rows = <T>(db: Connection, query: AnyQuery): Promise<T[]> =>
  db.all<T>({ toSql: dialect => query.toSql(dialect as never) as SqlResult<T> })

export const one = <T>(db: Connection, query: AnyQuery): Promise<T | null> =>
  db.one<T>({ toSql: dialect => query.toSql(dialect as never) as SqlResult<T> })

export const countRows = async (db: Connection, query: AnyQuery): Promise<number> => {
  // COUNT returns BIGINT on Postgres, which the driver may hand back as a
  // string — Number() normalizes both dialects to a JS number.
  const [row] = await rows<{ total: number | string }>(db, query)
  return Number(row?.total ?? 0)
}

// Clamps client-supplied paging so a request can't ask for the whole table.
export const paging = (query: Record<string, string | undefined>, fallback = 20, ceiling = 100) => {
  const limit = Math.min(Math.max(Number(query.limit) || fallback, 1), ceiling)
  const page = Math.max(Number(query.page) || 1, 1)
  const offset = query.offset !== undefined && Number(query.offset) >= 0 ? Number(query.offset) : (page - 1) * limit
  return { limit, offset, page }
}
