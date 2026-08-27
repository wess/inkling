import { dirname, relative, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../docs")
const BASE = "https://wess.io/inkling/"
const errors: string[] = []
const files = [...new Bun.Glob("**/*.html").scanSync({ cwd: ROOT, absolute: true, onlyFiles: true })].sort()
const pages = new Map<string, string>()
const llmsFile = resolve(ROOT, "llms.txt")
const agentDocs = [
  llmsFile,
  resolve(ROOT, "llms-full.txt"),
  resolve(ROOT, "agent-guide.md"),
  resolve(ROOT, "delivery.md"),
]

for (const file of files) pages.set(file, await Bun.file(file).text())

const label = (file: string): string => relative(ROOT, file)
const report = (file: string, message: string): void => {
  errors.push(`${label(file)}: ${message}`)
}
const idsIn = (html: string): Set<string> =>
  new Set([...html.matchAll(/<[a-z][^>]*\sid="([^"]+)"[^>]*>/gi)].map(match => match[1] as string))

const canonicalFor = (file: string): string => {
  const path = label(file).replace(/index\.html$/, "")
  return new URL(path, BASE).toString()
}

const localTarget = (file: string, value: string): { path: string; hash: string } | null => {
  if (/^(?:mailto:|tel:|data:|blob:)/.test(value)) return null
  if (/^https?:\/\//.test(value)) {
    if (!value.startsWith(BASE)) return null
    const url = new URL(value)
    return {
      path: resolve(ROOT, url.pathname.replace(/^\/inkling\/?/, "")),
      hash: url.hash.slice(1),
    }
  }
  if (value.startsWith("//")) return null
  if (value.startsWith("/")) {
    report(file, `root-relative link escapes the /inkling/ Pages site: ${value}`)
    return null
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    report(file, `unsupported link scheme: ${value}`)
    return null
  }

  const [withoutHash, hash = ""] = value.split("#", 2)
  const path = withoutHash.split("?", 1)[0] ?? ""
  return { path: resolve(dirname(file), decodeURIComponent(path || "")), hash: decodeURIComponent(hash) }
}

for (const [file, html] of pages) {
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim()
  if (!title) report(file, "missing a title")
  if (!/<meta name="description" content="[^"]+">/i.test(html)) report(file, "missing a description")
  if ((html.match(/<h1(?:\s|>)/gi) ?? []).length !== 1) report(file, "must contain exactly one h1")
  if (!/<link rel="describedby" href="[^"]+">/i.test(html)) {
    report(file, "missing a describedby link to llms.txt")
  }

  const ids = [...html.matchAll(/<[a-z][^>]*\sid="([^"]+)"[^>]*>/gi)].map(match => match[1] as string)
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  for (const id of new Set(duplicates)) report(file, `duplicate id: ${id}`)

  if (label(file) !== "404.html") {
    const canonical = html.match(/<link rel="canonical" href="([^"]+)">/i)?.[1]
    const expected = canonicalFor(file)
    if (canonical !== expected) report(file, `canonical must be ${expected}`)
  }

  for (const tag of html.matchAll(/<[a-z][^>]*\s(?:href|src)="([^"]+)"[^>]*>/gi)) {
    const value = tag[1] as string
    const target = localTarget(file, value)
    if (!target) continue

    const outside = relative(ROOT, target.path)
    if (outside.startsWith("..")) {
      report(file, `link leaves docs/: ${value}`)
      continue
    }

    let path = target.path
    if (!(await Bun.file(path).exists())) path = resolve(path, "index.html")
    const linked = pages.get(path) ?? ((await Bun.file(path).exists()) ? await Bun.file(path).text() : null)
    if (linked === null) {
      report(file, `missing target: ${value}`)
      continue
    }
    if (target.hash && !idsIn(linked).has(target.hash)) report(file, `missing fragment: ${value}`)
  }
}

for (const file of agentDocs) {
  if (!(await Bun.file(file).exists())) report(file, "missing machine-readable documentation")
}

if (await Bun.file(llmsFile).exists()) {
  const llms = await Bun.file(llmsFile).text()
  if (!/^# Inkling\n\n> /u.test(llms)) report(llmsFile, "must begin with one h1 and a summary blockquote")
  if ((llms.match(/^# /gm) ?? []).length !== 1) report(llmsFile, "must contain exactly one h1")
  if (new TextEncoder().encode(llms).byteLength > 10_000) report(llmsFile, "must stay under 10 KB")

  for (const section of llms.split(/^## /m).slice(1)) {
    const heading = section.split("\n", 1)[0] ?? "unnamed"
    if (!/^[-*] \[[^\]]+\]\([^)]+\)(?:: .+)?$/m.test(section)) {
      report(llmsFile, `section has no file-list entry: ${heading}`)
    }
  }

  for (const match of llms.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const value = match[1] as string
    const target = localTarget(llmsFile, value)
    if (!target) continue
    let path = target.path
    if (!(await Bun.file(path).exists())) path = resolve(path, "index.html")
    if (!(await Bun.file(path).exists())) report(llmsFile, `missing target: ${value}`)
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`docs: ${error}`)
  process.exitCode = 1
} else {
  console.log(`docs: ${files.length} HTML pages and the agent documents are valid`)
}
