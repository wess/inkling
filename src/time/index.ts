// Timestamps are stored as ISO-8601 TEXT. Postgres TIMESTAMPTZ hands back a
// Date while SQLite hands back a string for the same column, so storing text
// keeps row shapes identical across dialects and keeps lexical sort == chrono
// sort. Always UTC, always millisecond precision.

export const now = (): string => new Date().toISOString()

export const at = (value: Date | number | string): string => new Date(value).toISOString()

export const isFuture = (iso: string | null): boolean => iso !== null && iso > now()

export const isPast = (iso: string | null): boolean => iso !== null && iso <= now()

// Accepts anything Date can parse and normalizes it, or returns null when the
// input is absent/garbage. Used to sanitize client-supplied scheduling dates.
export const parseIso = (value: unknown): string | null => {
  if (typeof value !== "string" || value.trim() === "") return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}
