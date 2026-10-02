import { badRequest } from "atlas/server"

export type VisualLayout = { order: string[]; hidden: string[] }

export const readLayout = (input: unknown): VisualLayout => {
  const fail = (): never => {
    throw badRequest("Page layout needs valid section names", {
      code: "VALIDATION_FAILED",
      details: { fields: [{ key: "__layout", message: "Choose sections from this page" }] },
    })
  }
  if (input === undefined || input === null) return { order: [], hidden: [] }
  if (typeof input !== "object" || Array.isArray(input)) return fail()
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => key !== "order" && key !== "hidden")) return fail()
  const ids = (list: unknown): string[] => {
    if (list === undefined) return []
    if (!Array.isArray(list) || list.length > 100) return fail()
    if (list.some(id => typeof id !== "string" || !/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(id))) return fail()
    if (new Set(list).size !== list.length) return fail()
    return [...list]
  }
  return { order: ids(value.order), hidden: ids(value.hidden) }
}
