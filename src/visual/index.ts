import type { Connection } from "atlas/db"
import type { Route } from "atlas/server"
import { get, json, pipeline } from "atlas/server"
import { parseHTML } from "linkedom"
import { requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { readLayout } from "./layout.ts"

export type { VisualLayout } from "./layout.ts"

export type VisualSection = {
  id: string
  label: string
  selector: string
  fields: string[]
  movable?: boolean
  collection?: { type: string; label: string }
}

export type VisualPage = {
  sections: VisualSection[]
  fields?: Record<string, string>
  references?: Record<string, { type: string; label: string }>
}

export type VisualPages = Record<string, VisualPage>

export const visualRoutes = (db: Connection, pages: VisualPages): Route[] => [
  get(
    "/visual",
    pipeline(requireAuth(db), requireCan(can.readContent, "read content"))(c => json(c, 200, { data: pages })),
  ),
]

// Only host-declared elements can move. Keeping a slot for each movable sibling
// leaves headers, forms, scripts, and fixed sections in their original position.
export const renderVisual = (html: string, definition: VisualPage, layout: unknown, editing = false): string => {
  const { document } = parseHTML(html)
  const stored = readLayout(layout)
  const found = definition.sections.flatMap(section => {
    const element = document.querySelector(section.selector)
    return element ? [{ section, element }] : []
  })

  for (const { section, element } of found) {
    if (editing) {
      element.setAttribute("data-inkling-section", section.id)
      element.setAttribute("data-inkling-label", section.label)
      if (stored.hidden.includes(section.id)) element.setAttribute("data-inkling-hidden", "true")
    }
  }
  if (editing) {
    for (const [field, selector] of Object.entries(definition.fields ?? {})) {
      for (const element of document.querySelectorAll(selector)) element.setAttribute("data-inkling-field", field)
    }
  }

  const movable = found.filter(
    ({ section, element }) =>
      section.movable !== false && !found.some(other => other.element !== element && other.element.contains(element)),
  )
  const parents = new Set(movable.map(({ element }) => element.parentNode))
  for (const parent of parents) {
    if (!parent) continue
    const positions = Array.from(parent.childNodes).filter(node => movable.some(item => item.element === node))
    const siblings = positions.flatMap(node => movable.filter(item => item.element === node))
    const desired = [
      ...stored.order.flatMap(id => siblings.filter(item => item.section.id === id)),
      ...siblings.filter(item => !stored.order.includes(item.section.id)),
    ]
    const slots = positions.map(element => {
      const slot = document.createComment("section")
      parent.replaceChild(slot, element)
      return slot
    })
    for (const [index, slot] of slots.entries()) {
      const item = desired[index]
      if (item) parent.replaceChild(item.element, slot)
    }
  }
  if (!editing) {
    for (const { section, element } of found) {
      if (stored.hidden.includes(section.id)) element.remove()
    }
  }
  return document.toString()
}
