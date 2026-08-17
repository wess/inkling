import { expect, test } from "bun:test"
import type { Field } from "../src/fields/index.ts"
import { blank, validate, validateDefinition } from "../src/fields/index.ts"

const field = (over: Partial<Field> & Pick<Field, "key" | "type">): Field => ({ label: over.key, ...over }) as Field

test("coerces and bounds scalars", () => {
  const fields = [
    field({ key: "name", type: "text", max: 5 }),
    field({ key: "count", type: "number", min: 1, max: 10 }),
    field({ key: "live", type: "boolean" }),
  ]

  const ok = validate(fields, { name: "abc", count: "7", live: "true" })
  expect(ok.valid).toBe(true)
  if (ok.valid) expect(ok.data).toEqual({ name: "abc", count: 7, live: true })

  const long = validate(fields, { name: "abcdef", count: 5 })
  expect(long.valid).toBe(false)
  if (!long.valid) expect(long.errors[0]?.key).toBe("name")

  const high = validate(fields, { name: "a", count: 99 })
  expect(high.valid).toBe(false)
  if (!high.valid) expect(high.errors[0]?.message).toContain("at most 10")
})

test("rejects select values outside the declared options", () => {
  const fields = [
    field({
      key: "status",
      type: "select",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    }),
  ]
  expect(validate(fields, { status: "a" }).valid).toBe(true)
  expect(validate(fields, { status: "z" }).valid).toBe(false)
})

test("enforces required, treating empty string and empty array as absent", () => {
  const fields = [
    field({ key: "title", type: "text", required: true }),
    field({ key: "tags", type: "gallery", required: true }),
  ]
  const result = validate(fields, { title: "", tags: [] })
  expect(result.valid).toBe(false)
  if (!result.valid) expect(result.errors.map(e => e.key).sort()).toEqual(["tags", "title"])
})

test("validates nested list rows and reports which row failed", () => {
  const fields = [
    field({
      key: "rows",
      type: "list",
      fields: [field({ key: "label", type: "text", required: true }), field({ key: "amount", type: "number" })],
    }),
  ]

  const ok = validate(fields, { rows: [{ label: "One", amount: "3" }] })
  expect(ok.valid).toBe(true)
  if (ok.valid) expect(ok.data.rows).toEqual([{ label: "One", amount: 3 }])

  const bad = validate(fields, { rows: [{ label: "One" }, { amount: 2 }] })
  expect(bad.valid).toBe(false)
  if (!bad.valid) expect(bad.errors[0]?.message).toContain("item 2")
})

// An absent key must keep the field's empty value rather than throwing, so the
// editor can send only what it rendered.
test("fills absent keys instead of failing", () => {
  const fields = [field({ key: "a", type: "text" }), field({ key: "b", type: "number" })]
  const result = validate(fields, {})
  expect(result.valid).toBe(true)
  if (result.valid) expect(result.data).toEqual({ a: "", b: null })
})

test("blank() produces the zero state including defaults", () => {
  expect(blank([field({ key: "a", type: "text", default: "hi" }), field({ key: "b", type: "gallery" })])).toEqual({
    a: "hi",
    b: [],
  })
})

test("accepts site-relative and mailto urls, rejects other schemes", () => {
  const fields = [field({ key: "link", type: "url" })]
  for (const good of ["/shop", "#top", "https://example.com", "mailto:a@b.co"]) {
    expect(validate(fields, { link: good }).valid).toBe(true)
  }
  expect(validate(fields, { link: "javascript:alert(1)" }).valid).toBe(false)
})

test("field definitions must have unique camelCase keys and known types", () => {
  expect(validateDefinition([{ key: "heroHeading", type: "text", label: "Hero" }]).ok).toBe(true)
  expect(validateDefinition([{ key: "Hero", type: "text", label: "x" }]).ok).toBe(false)
  expect(validateDefinition([{ key: "hero-heading", type: "text", label: "x" }]).ok).toBe(false)
  expect(validateDefinition([{ key: "a", type: "nope", label: "x" }]).ok).toBe(false)
  expect(
    validateDefinition([
      { key: "a", type: "text", label: "x" },
      { key: "a", type: "text", label: "y" },
    ]).ok,
  ).toBe(false)
  // A select with no options can never be satisfied, so it's rejected up front.
  expect(validateDefinition([{ key: "a", type: "select", label: "x" }]).ok).toBe(false)
})

test("field definitions reject invalid constraints before editors can use them", () => {
  expect(validateDefinition([{ key: "price", type: "number", label: "Price", min: 10, max: 5 }]).ok).toBe(false)
  expect(validateDefinition([{ key: "code", type: "text", label: "Code", pattern: "[" }]).ok).toBe(false)
  expect(
    validateDefinition([
      {
        key: "size",
        type: "select",
        label: "Size",
        options: [
          { value: "small", label: "Small" },
          { value: "small", label: "Still small" },
        ],
      },
    ]).ok,
  ).toBe(false)
  expect(validateDefinition([{ key: "author", type: "reference", label: "Author" }]).ok).toBe(false)
  expect(validateDefinition([{ key: "title", type: "text", label: "Title", multiple: true }]).ok).toBe(false)
  expect(blank([{ key: "authors", type: "reference", label: "Authors", of: "person", multiple: true }])).toEqual({
    authors: [],
  })
  expect(validateDefinition([{ key: "links", type: "list", label: "Links", fields: [] }]).ok).toBe(false)
})

test("a field pattern that can hang the process is refused when the type is saved", () => {
  // `field.pattern` is a regex somebody types into the content-type editor and
  // it runs against entry data on every save. Checking only that it compiles let
  // `(a+)+$` through, and Bun runs one JS thread — so a single save wedges the
  // instance. These are the shapes that actually get written.
  for (const pattern of ["(a+)+$", "(a|a)*$", "([a-z]+)*x", "(x{1,}){2,}", "(?:a+)+b", "(\\w+\\s?)*$"]) {
    const result = validateDefinition([{ key: "code", type: "text", label: "Code", pattern }])
    expect(result.ok).toBe(false)
  }

  // Length is its own limit, so a pattern cannot be a payload.
  expect(validateDefinition([{ key: "code", type: "text", label: "Code", pattern: "a".repeat(201) }]).ok).toBe(false)

  // And the patterns a person actually wants still work — a heuristic that
  // refused these would be worse than the problem.
  for (const pattern of [
    "^[a-z]+$",
    "^\\d{4}-\\d{2}-\\d{2}$",
    "^(cat|dog)$",
    "^#[0-9a-f]{6}$",
    "(abc)+",
    "(ab){3}",
    "^\\+?[0-9 ()-]{7,20}$",
  ]) {
    const result = validateDefinition([{ key: "code", type: "text", label: "Code", pattern }])
    expect(result.ok).toBe(true)
  }
})

test("a stored pattern is refused at match time, not only when the type is edited", () => {
  // `validateDefinition` guards the admin editor, and it is not the only way a
  // pattern gets stored: a plugin declares content types through `upsertOwned`,
  // which never sees it, and rows written before the check existed are still on
  // disk. So the refusal has to happen where the pattern is compiled — these
  // fields stand in for both, having never been through the editor.
  const hostile = validate([field({ key: "code", type: "text", pattern: "(a+)+$" })], { code: "aaaaaaaaaaaaaaaaaaaa!" })
  expect(hostile.valid).toBe(false)
  if (!hostile.valid) expect(hostile.errors[0]?.key).toBe("code")

  // Same for one that no longer compiles: a field error, not a thrown 500.
  const broken = validate([field({ key: "code", type: "text", pattern: "([" })], { code: "anything" })
  expect(broken.valid).toBe(false)

  // A safe pattern still matches, and still rejects a non-match.
  const good = [field({ key: "code", type: "text", pattern: "^[a-z]{3}$" })]
  expect(validate(good, { code: "abc" }).valid).toBe(true)
  expect(validate(good, { code: "ab1" }).valid).toBe(false)
})

test("the shape the guard refuses really does hang, rather than theoretically", () => {
  // Proof the heuristic is aimed at something real: run directly, this blocks
  // the only JS thread there is. Measured on Bun 1.3, the curve is steep — 20
  // characters costs ~9ms, 24 costs ~130ms, and `^(([a-z])+.)+[A-Z]([a-z])+$`
  // reaches seconds. 20 is used here because the test asserts the shape, not the
  // clock, and 130ms is 90% of this file's runtime for the same information.
  const started = Date.now()
  ;/(a+)+$/.test(`${"a".repeat(20)}!`)
  const elapsed = Date.now() - started

  // A linear regex answers this in microseconds, so the margin is still ~4x
  // even though the absolute cost is small.
  expect(elapsed).toBeGreaterThan(2)
})
