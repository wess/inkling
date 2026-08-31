#!/usr/bin/env bun
//
// The sites this Inkling powers, and whether they are current.
//
//   bun run scripts/sites.ts            # status of every site
//   bun run scripts/sites.ts <name>     # just one
//
// Two questions it answers, because they fail independently: is the site up,
// and is it running the release we think it is. A site can be perfectly healthy
// and three versions behind, which is the state that quietly accumulates.
//
// Health is read over the public URL. The deployed version is read out of the
// container over SSH, because it is deliberately not exposed publicly — the
// version of a CMS is a hint about which advisories apply to it, and /health is
// reachable by anyone.

import { $ } from "bun"

type Site = {
  readonly name: string
  readonly url: string
  // Where the CMS answers. Not always /admin — 803media calls it a studio.
  readonly admin: string
  // SSH alias and container name, for reading the deployed version. Null for a
  // site we do not operate.
  readonly host: string | null
  readonly container: string | null
}

// Adding a site is a line here. Everything below is generic.
const SITES: readonly Site[] = [
  {
    name: "apothecary",
    url: "https://apothecary.wess.dev",
    admin: "/admin",
    host: "gohan",
    container: "apothecary",
  },
  {
    name: "803media",
    url: "https://803media.wess.dev",
    admin: "/studio",
    host: "gohan",
    container: "803media",
  },
  {
    name: "inkling",
    url: "https://inkling.host",
    admin: "/admin",
    host: "gohan",
    container: "inkling",
  },
  {
    name: "warren",
    url: "https://warren.wess.dev",
    admin: "/admin",
    host: "gohan",
    container: "warren",
  },
]

const TIMEOUT_MS = 15_000

// The release this working copy would publish, so "behind" means something.
const latest = async (): Promise<string> => {
  const described = await $`git describe --tags --abbrev=0`.quiet().nothrow()
  return described.exitCode === 0 ? described.stdout.toString().trim().replace(/^v/, "") : "unknown"
}

const probe = async (url: string): Promise<number | null> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" })
    return response.status
  } catch {
    return null
  }
}

// Read out of the running container rather than from a deploy record: what is
// actually serving is the only version that matters.
const deployed = async (site: Site): Promise<string> => {
  if (!site.host || !site.container) return "—"
  const result =
    await $`ssh -o ConnectTimeout=10 -o BatchMode=yes ${site.host} sudo docker exec ${site.container} cat /app/node_modules/inkling/package.json`
      .quiet()
      .nothrow()

  if (result.exitCode !== 0) return "unreachable"
  try {
    return (JSON.parse(result.stdout.toString()) as { version?: string }).version ?? "unknown"
  } catch {
    return "unreadable"
  }
}

const status = async (site: Site, current: string) => {
  const [health, home, admin, version] = await Promise.all([
    probe(`${site.url}/health`),
    probe(`${site.url}/`),
    probe(`${site.url}${site.admin}`),
    deployed(site),
  ])

  const up = health === 200 && home === 200 && admin === 200
  const note =
    version === current
      ? "current"
      : version === "—" || version === "unreachable" || version === "unknown"
        ? version
        : `behind ${current}`

  return {
    name: site.name,
    health: up ? "ok" : `health ${health ?? "×"} · site ${home ?? "×"} · admin ${admin ?? "×"}`,
    version,
    note,
    ok: up && version === current,
  }
}

const [only] = process.argv.slice(2)
const wanted = only ? SITES.filter(site => site.name === only) : SITES

if (wanted.length === 0) {
  console.error(`No site named "${only}". Known: ${SITES.map(s => s.name).join(", ")}`)
  process.exit(1)
}

const current = await latest()
console.log(`inkling ${current} is the current release\n`)

const rows = await Promise.all(wanted.map(site => status(site, current)))

const width = Math.max(...rows.map(row => row.name.length), 4)
for (const row of rows) {
  const mark = row.ok ? "  " : "! "
  console.log(`${mark}${row.name.padEnd(width)}  ${row.version.padEnd(12)} ${row.note.padEnd(14)} ${row.health}`)
}

// Non-zero when anything is down or behind, so this can gate a deploy or run
// unattended without someone reading the output.
process.exit(rows.every(row => row.ok) ? 0 : 1)
