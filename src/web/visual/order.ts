export const reorderSections = <T extends { id: string; movable?: boolean }>(
  sections: T[],
  from: string,
  to: string,
): string[] | null => {
  const start = sections.findIndex(section => section.id === from)
  const end = sections.findIndex(section => section.id === to)
  if (start < 0 || end < 0 || start === end) return null
  if (sections.slice(Math.min(start, end), Math.max(start, end) + 1).some(section => section.movable === false))
    return null
  const order = sections.map(section => section.id)
  order.splice(start, 1)
  order.splice(end, 0, from)
  return order
}
