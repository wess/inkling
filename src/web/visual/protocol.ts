import type { Selection } from "./selection.ts"

export type FrameRect = { x: number; y: number; width: number; height: number }

export const selectionKey = (selection: Selection): string =>
  JSON.stringify([selection.shared ?? null, selection.field ?? null, selection.section ?? null])

export const readSelection = (value: unknown, shared: string[], labels: Record<string, string>): Selection | null => {
  if (!value || typeof value !== "object") return null
  const input = value as Record<string, unknown>
  if (typeof input.shared === "string") return shared.includes(input.shared) ? { shared: input.shared } : null
  const field = typeof input.field === "string" && Object.hasOwn(labels, input.field) ? input.field : undefined
  const section = typeof input.section === "string" && Object.hasOwn(labels, input.section) ? input.section : undefined
  return field || section ? { field, section } : null
}

export const readRect = (value: unknown): FrameRect | null => {
  if (!value || typeof value !== "object") return null
  const rect = value as Record<string, unknown>
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(
      number => typeof number === "number" && Number.isFinite(number) && Math.abs(number) < 1e7,
    )
  )
    return null
  if ((rect.width as number) < 0 || (rect.height as number) < 0) return null
  return { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number }
}
