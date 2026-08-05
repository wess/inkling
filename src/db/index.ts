import type { Connection } from "atlas/db"
import { connect } from "atlas/db"
import { config } from "../config/index.ts"

// Inkling runs on either dialect from one migration set. The portability rules
// live in `docs/ARCHITECTURE.md`; the short version is that every column type
// we use round-trips to the same JS value on both drivers (TEXT ids, TEXT
// ISO-8601 timestamps, TEXT JSON, INTEGER booleans). Anything dialect-specific
// goes through `src/db/dialect.ts` rather than being inlined at a call site.

export const openDb = async (url: string = config.databaseUrl): Promise<Connection> => {
  const connection = url.startsWith("postgres")
    ? connect({ driver: "postgres", url, pool: config.dbPool })
    : connect({ driver: "sqlite", path: url.replace(/^sqlite:\/\//, "") })

  // SQLite leaves foreign-key enforcement off unless each connection enables
  // it. Without this, the same ON DELETE CASCADE migrations behave differently
  // from Postgres and leave orphaned revisions, terms, and plugin-owned rows.
  if (connection.dialect === "sqlite") {
    await connection.execute({ text: "PRAGMA foreign_keys = ON", values: [] })
  }

  return connection
}

export const db: Connection = await openDb()

export type { Connection }
