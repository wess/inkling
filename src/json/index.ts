// JSON columns are TEXT on both dialects so the drivers return the same thing
// (a string) instead of Postgres pre-parsing JSONB into an object while SQLite
// does not. Every read goes through `decode`, every write through `encode`.

export const encode = (value: unknown): string => JSON.stringify(value ?? null)

export const decode = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback
  if (typeof value !== "string") return value as T
  try {
    const parsed = JSON.parse(value)
    return parsed === null ? fallback : (parsed as T)
  } catch {
    return fallback
  }
}

export const decodeObject = (value: unknown): Record<string, unknown> => decode<Record<string, unknown>>(value, {})

export const decodeArray = <T>(value: unknown): T[] => decode<T[]>(value, [])

// Booleans are INTEGER 0/1 columns for the same cross-dialect reason.
export const toBit = (value: unknown): number => (value ? 1 : 0)

export const fromBit = (value: unknown): boolean => value === 1 || value === true || value === "1"
