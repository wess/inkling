const escapeText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const blocked = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE"])

// Headings keep inline emphasis and line breaks, never pasted styles or blocks.
export const inlineHtml = (root: Element): string => {
  const children = (parent: Node): string => {
    let output = ""
    for (const node of parent.childNodes) {
      if (node.nodeType === 3) {
        output += escapeText(node.textContent ?? "").replace(/\r?\n/g, "<br>")
        continue
      }
      if (node.nodeType !== 1) continue
      const element = node as Element
      const tag = element.tagName.toUpperCase()
      if (blocked.has(tag)) continue
      if (tag === "BR") {
        output += "<br>"
        continue
      }
      const content = children(element)
      if ((tag === "DIV" || tag === "P") && output && !output.endsWith("<br>")) output += "<br>"
      output += tag === "I" || tag === "EM" ? `<i>${content}</i>` : content
      if ((tag === "DIV" || tag === "P") && node.nextSibling && !output.endsWith("<br>")) output += "<br>"
    }
    return output
  }
  const html = children(root)
  return html.replace(/<[^>]+>|&nbsp;/g, "").trim() ? html : ""
}
