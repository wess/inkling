import { existsSync, readdirSync } from "node:fs"
import type { Connection } from "atlas/db"

// Inkling runs its own migration runner instead of `atlas/migrate#up`.
// Reason: that runner hands a whole up.sql to `db.execute` as one statement.
// bun:sqlite's `prepare(sql).run()` executes only the *first* statement of a
// multi-statement string and reports success, so a migration that creates three
// tables would create one and still be recorded as applied. Splitting here and
// executing statement-by-statement is the fix, and it also gives us a real
// transaction around each migration on both dialects.

export type Migration = {
  readonly name: string
  readonly dir: string
}

// Splits on semicolons that are actually statement terminators — ignoring ones
// inside single/double-quoted strings, line comments, block comments, and
// Postgres dollar-quoted bodies ($$ ... $$ / $tag$ ... $tag$).
export const splitStatements = (sql: string): string[] => {
  const out: string[] = []
  let buf = ""
  let i = 0

  while (i < sql.length) {
    const ch = sql[i] as string
    const next = sql[i + 1]

    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i)
      i = end === -1 ? sql.length : end + 1
      buf += " "
      continue
    }

    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2)
      i = end === -1 ? sql.length : end + 2
      buf += " "
      continue
    }

    if (ch === "'" || ch === '"') {
      const quote = ch
      buf += ch
      i += 1
      while (i < sql.length) {
        buf += sql[i]
        if (sql[i] === quote) {
          // Doubled quote is an escaped quote, not a terminator.
          if (sql[i + 1] === quote) {
            buf += sql[i + 1]
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }

    if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
      if (tag) {
        const marker = tag[0]
        const end = sql.indexOf(marker, i + marker.length)
        const stop = end === -1 ? sql.length : end + marker.length
        buf += sql.slice(i, stop)
        i = stop
        continue
      }
    }

    if (ch === ";") {
      if (buf.trim()) out.push(buf.trim())
      buf = ""
      i += 1
      continue
    }

    buf += ch
    i += 1
  }

  if (buf.trim()) out.push(buf.trim())
  return out
}

export const scan = (dir: string): Migration[] => {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => existsSync(`${dir}/${name}/up.sql`) && existsSync(`${dir}/${name}/down.sql`))
    .sort((a, b) => a.localeCompare(b))
    .map(name => ({ name, dir: `${dir}/${name}` }))
}

const ensureTable = async (db: Connection): Promise<void> => {
  await db.execute({
    text: `CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
    values: [],
  })
}

const applied = async (db: Connection): Promise<Set<string>> => {
  const rows = await db.all<{ name: string }>({ text: "SELECT name FROM schema_migrations", values: [] })
  return new Set(rows.map(r => r.name))
}

const param = (db: Connection, index: number): string => (db.dialect === "postgres" ? `$${index}` : "?")

const runFile = async (db: Connection, path: string): Promise<void> => {
  const sql = await Bun.file(path).text()
  for (const statement of splitStatements(sql)) {
    await db.execute({ text: statement, values: [] })
  }
}

// `namespace` keeps plugin migrations from colliding with core ones in
// schema_migrations — a plugin's rows are recorded as "plugin:seo/0001_init".
export const up = async (db: Connection, dir: string, namespace = ""): Promise<string[]> => {
  await ensureTable(db)
  const done = await applied(db)
  const ran: string[] = []

  for (const migration of scan(dir)) {
    const key = namespace ? `${namespace}/${migration.name}` : migration.name
    if (done.has(key)) continue

    await db.transaction(async tx => {
      await runFile(tx, `${migration.dir}/up.sql`)
      await tx.execute({
        text: `INSERT INTO schema_migrations (name, applied_at) VALUES (${param(tx, 1)}, ${param(tx, 2)})`,
        values: [key, new Date().toISOString()],
      })
    })
    ran.push(key)
  }

  return ran
}

export const down = async (db: Connection, dir: string, namespace = ""): Promise<string | null> => {
  await ensureTable(db)
  const done = await applied(db)

  for (const migration of scan(dir).reverse()) {
    const key = namespace ? `${namespace}/${migration.name}` : migration.name
    if (!done.has(key)) continue

    await db.transaction(async tx => {
      await runFile(tx, `${migration.dir}/down.sql`)
      await tx.execute({
        text: `DELETE FROM schema_migrations WHERE name = ${param(tx, 1)}`,
        values: [key],
      })
    })
    return key
  }

  return null
}

// Roll every migration in `dir` back, newest first. Used when a plugin is
// uninstalled so its tables leave with it.
export const downAll = async (db: Connection, dir: string, namespace = ""): Promise<string[]> => {
  const rolled: string[] = []
  let next = await down(db, dir, namespace)
  while (next) {
    rolled.push(next)
    next = await down(db, dir, namespace)
  }
  return rolled
}

export const status = async (db: Connection, dir: string, namespace = "") => {
  await ensureTable(db)
  const done = await applied(db)
  return scan(dir).map(m => {
    const key = namespace ? `${namespace}/${m.name}` : m.name
    return { name: key, applied: done.has(key) }
  })
}
