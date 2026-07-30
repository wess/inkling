import { isFieldKey, isHandle } from "../ids/index.ts"

// A content type's `fields` column is an array of these. The registry below is
// the single place that knows how a field validates, what its empty value is,
// and how the admin SPA should render it — plugins extend it via
// `fields` on a plugin definition rather than by editing this file.

export type FieldType =
  | "text"
  | "textarea"
  | "richtext"
  | "markdown"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "select"
  | "multiselect"
  | "media"
  | "gallery"
  | "reference"
  | "list"
  | "json"
  | "color"
  | "url"
  | "email"

export type FieldOption = { readonly value: string; readonly label: string }

export type Field = {
  readonly key: string
  readonly type: FieldType
  readonly label: string
  readonly help?: string
  readonly required?: boolean
  readonly localized?: boolean
  readonly multiple?: boolean
  readonly default?: unknown
  readonly options?: readonly FieldOption[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  // `reference` targets a content type by name; `list` nests a field set.
  readonly of?: string
  readonly fields?: readonly Field[]
}

export type FieldError = { readonly key: string; readonly message: string }

export type ValidationResult =
  | { readonly valid: true; readonly data: Record<string, unknown> }
  | { readonly valid: false; readonly errors: readonly FieldError[] }

type Handler = {
  readonly empty: unknown
  // Returns the coerced value, or an error message string.
  readonly coerce: (value: unknown, field: Field) => unknown | { error: string }
}

const err = (message: string) => ({ error: message })

const isErr = (value: unknown): value is { error: string } =>
  typeof value === "object" && value !== null && "error" in value

const str = (max: number): Handler => ({
  empty: "",
  coerce: (value, field) => {
    if (typeof value !== "string") return err("must be a string")
    const limit = field.max ?? max
    if (value.length > limit) return err(`must be at most ${limit} characters`)
    if (field.min !== undefined && value.length < field.min) return err(`must be at least ${field.min} characters`)
    if (field.pattern && !new RegExp(field.pattern).test(value)) return err("does not match the required format")
    return value
  },
})

const REGISTRY: Record<FieldType, Handler> = {
  text: str(1_000),
  textarea: str(20_000),
  richtext: str(500_000),
  markdown: str(500_000),
  color: {
    empty: "",
    coerce: value =>
      typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
        ? value
        : err("must be a hex color like #1a2b3c"),
  },
  url: {
    empty: "",
    coerce: value => {
      if (typeof value !== "string") return err("must be a string")
      if (value === "") return value
      // Site-relative links are the common case in a CMS, so allow them
      // alongside absolute URLs rather than forcing an origin.
      if (value.startsWith("/") || value.startsWith("#")) return value
      try {
        const parsed = new URL(value)
        return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:"
          ? value
          : err("must be an http, https, or mailto URL")
      } catch {
        return err("must be a valid URL")
      }
    },
  },
  email: {
    empty: "",
    coerce: value =>
      typeof value === "string" && (value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        ? value
        : err("must be an email address"),
  },
  number: {
    empty: null,
    coerce: (value, field) => {
      if (value === "" || value === null || value === undefined) return null
      const parsed = typeof value === "number" ? value : Number(value)
      if (!Number.isFinite(parsed)) return err("must be a number")
      if (field.min !== undefined && parsed < field.min) return err(`must be at least ${field.min}`)
      if (field.max !== undefined && parsed > field.max) return err(`must be at most ${field.max}`)
      return parsed
    },
  },
  boolean: {
    empty: false,
    coerce: value => value === true || value === 1 || value === "true" || value === "1",
  },
  date: {
    empty: null,
    coerce: value => {
      if (value === "" || value === null || value === undefined) return null
      if (typeof value !== "string") return err("must be a date string")
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return err("must be formatted YYYY-MM-DD")
      return Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? err("is not a real date") : value
    },
  },
  datetime: {
    empty: null,
    coerce: value => {
      if (value === "" || value === null || value === undefined) return null
      if (typeof value !== "string") return err("must be a datetime string")
      const parsed = new Date(value)
      return Number.isNaN(parsed.getTime()) ? err("is not a valid datetime") : parsed.toISOString()
    },
  },
  select: {
    empty: "",
    coerce: (value, field) => {
      if (value === "" || value === null || value === undefined) return ""
      if (typeof value !== "string") return err("must be a string")
      const allowed = (field.options ?? []).map(o => o.value)
      return allowed.includes(value) ? value : err(`must be one of: ${allowed.join(", ")}`)
    },
  },
  multiselect: {
    empty: [],
    coerce: (value, field) => {
      if (!Array.isArray(value)) return err("must be a list")
      const allowed = (field.options ?? []).map(o => o.value)
      const bad = value.filter(v => typeof v !== "string" || !allowed.includes(v))
      return bad.length > 0 ? err(`contains values outside: ${allowed.join(", ")}`) : value
    },
  },
  // Media fields hold media IDs. The delivery API expands them to full media
  // objects so a consuming site never has to make a second request.
  media: {
    empty: null,
    coerce: value => {
      if (value === "" || value === null || value === undefined) return null
      return typeof value === "string" ? value : err("must be a media id")
    },
  },
  gallery: {
    empty: [],
    coerce: value => {
      if (!Array.isArray(value)) return err("must be a list of media ids")
      return value.every(v => typeof v === "string") ? value : err("must contain only media ids")
    },
  },
  reference: {
    empty: null,
    coerce: value => {
      if (value === "" || value === null || value === undefined) return null
      if (typeof value === "string") return value
      if (Array.isArray(value) && value.every(v => typeof v === "string")) return value
      return err("must be an entry id or list of entry ids")
    },
  },
  list: {
    empty: [],
    coerce: (value, field) => {
      if (!Array.isArray(value)) return err("must be a list")
      if (field.max !== undefined && value.length > field.max) return err(`must have at most ${field.max} items`)
      if (field.min !== undefined && value.length < field.min) return err(`must have at least ${field.min} items`)

      const nested = field.fields ?? []
      if (nested.length === 0) return value

      const rows: Record<string, unknown>[] = []
      for (const [index, item] of value.entries()) {
        const result = validate(nested, (item ?? {}) as Record<string, unknown>)
        if (!result.valid) {
          return err(`item ${index + 1}: ${result.errors.map(e => `${e.key} ${e.message}`).join("; ")}`)
        }
        rows.push(result.data)
      }
      return rows
    },
  },
  json: {
    empty: null,
    coerce: value => {
      if (typeof value !== "string") return value ?? null
      try {
        return JSON.parse(value)
      } catch {
        return err("must be valid JSON")
      }
    },
  },
}

export const fieldTypes = Object.keys(REGISTRY) as FieldType[]

export const isFieldType = (value: string): value is FieldType => value in REGISTRY

export const emptyValue = (field: Field): unknown =>
  field.default ?? (field.type === "reference" && field.multiple ? [] : REGISTRY[field.type].empty)

// The zero-state of an entry: every declared field present with its empty or
// default value, so the editor never has to guess at undefined.
export const blank = (fields: readonly Field[]): Record<string, unknown> =>
  Object.fromEntries(fields.map(field => [field.key, emptyValue(field)]))

const isEmpty = (value: unknown): boolean =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)

export const validate = (fields: readonly Field[], input: Record<string, unknown>): ValidationResult => {
  const errors: FieldError[] = []
  const data: Record<string, unknown> = {}

  for (const field of fields) {
    const handler = REGISTRY[field.type]
    if (!handler) {
      errors.push({ key: field.key, message: `has unknown field type "${field.type}"` })
      continue
    }

    const supplied = input[field.key]
    // An absent key keeps the stored default rather than being treated as a
    // clear — partial updates from the editor only send what changed.
    const value = supplied === undefined ? emptyValue(field) : supplied

    if (isEmpty(value)) {
      if (field.required) errors.push({ key: field.key, message: "is required" })
      data[field.key] = field.type === "boolean" ? false : emptyValue(field)
      continue
    }

    const coerced = handler.coerce(value, field)
    if (isErr(coerced)) {
      errors.push({ key: field.key, message: coerced.error })
      continue
    }
    data[field.key] = coerced
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, data }
}

// Validates a field *definition* — used when saving a content type, so a bad
// schema is rejected at author time instead of at every entry save.
export const validateDefinition = (fields: unknown): { readonly ok: true } | { readonly ok: false; error: string } => {
  if (!Array.isArray(fields)) return { ok: false, error: "fields must be an array" }

  const seen = new Set<string>()
  for (const raw of fields) {
    const field = raw as Partial<Field>
    if (typeof field.key !== "string" || !isFieldKey(field.key)) {
      return {
        ok: false,
        error: `field key "${field.key}" must start with a lowercase letter and contain only letters and digits`,
      }
    }
    if (seen.has(field.key)) return { ok: false, error: `duplicate field key "${field.key}"` }
    seen.add(field.key)

    if (typeof field.type !== "string" || !isFieldType(field.type)) {
      return { ok: false, error: `field "${field.key}" has unknown type "${field.type}"` }
    }
    if (typeof field.label !== "string" || field.label.trim() === "") {
      return { ok: false, error: `field "${field.key}" needs a label` }
    }
    if (field.multiple !== undefined && (field.type !== "reference" || typeof field.multiple !== "boolean")) {
      return { ok: false, error: `field "${field.key}" has an invalid multiple setting` }
    }
    if (field.min !== undefined && (!Number.isFinite(field.min) || typeof field.min !== "number")) {
      return { ok: false, error: `field "${field.key}" has an invalid minimum` }
    }
    if (field.max !== undefined && (!Number.isFinite(field.max) || typeof field.max !== "number")) {
      return { ok: false, error: `field "${field.key}" has an invalid maximum` }
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      return { ok: false, error: `field "${field.key}" has a minimum greater than its maximum` }
    }
    if (field.pattern !== undefined) {
      if (typeof field.pattern !== "string") return { ok: false, error: `field "${field.key}" has an invalid pattern` }
      try {
        new RegExp(field.pattern)
      } catch {
        return { ok: false, error: `field "${field.key}" has an invalid pattern` }
      }
    }
    if (field.type === "select" || field.type === "multiselect") {
      if (!Array.isArray(field.options) || field.options.length === 0) {
        return { ok: false, error: `field "${field.key}" is a ${field.type} and needs options` }
      }
      const values = new Set<string>()
      for (const option of field.options) {
        if (
          typeof option?.value !== "string" ||
          option.value === "" ||
          typeof option.label !== "string" ||
          option.label.trim() === ""
        ) {
          return { ok: false, error: `field "${field.key}" has an invalid option` }
        }
        if (values.has(option.value)) return { ok: false, error: `field "${field.key}" has duplicate option values` }
        values.add(option.value)
      }
    }
    if (field.type === "reference" && (typeof field.of !== "string" || !isHandle(field.of))) {
      return { ok: false, error: `field "${field.key}" must name the content type it references` }
    }
    if (field.type === "list") {
      if (!field.fields || field.fields.length === 0) {
        return { ok: false, error: `field "${field.key}" is a list and needs nested fields` }
      }
      const nested = validateDefinition(field.fields)
      if (!nested.ok) return { ok: false, error: `inside "${field.key}": ${nested.error}` }
    }
  }

  return { ok: true }
}
