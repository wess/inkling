import type { SharedPart } from "../../website/index.ts"
import { BRIDGE, BRIDGE_HASH } from "./bridge.ts"

export const prepare = (html: string, url: string, parts: SharedPart[], channel: string, origin: string): string => {
  const doc = new DOMParser().parseFromString(html, "text/html")
  for (const element of doc.querySelectorAll("script, iframe, object, embed, base, meta")) element.remove()
  for (const element of doc.querySelectorAll("*")) {
    for (const attr of [...element.attributes]) {
      if (attr.name.startsWith("on") || attr.name === "autofocus") element.removeAttribute(attr.name)
    }
    for (const name of ["src", "href", "poster"]) {
      const value = element.getAttribute(name)
      if (value) {
        try {
          const resolved = new URL(value, url)
          if (["http:", "https:", "data:"].includes(resolved.protocol)) element.setAttribute(name, resolved.href)
          else element.removeAttribute(name)
        } catch {
          element.removeAttribute(name)
        }
      }
    }
  }
  for (const part of parts) {
    for (const el of doc.querySelectorAll(part.selector)) {
      el.setAttribute("data-inkling-shared", part.id)
      el.setAttribute("data-inkling-label", part.label)
    }
  }
  const style = doc.createElement("style")
  style.textContent = `
    html { scroll-behavior: auto !important; }
    [data-reveal] { opacity: 1 !important; transform: none !important; visibility: visible !important; }
    *, *::before, *::after { animation: none !important; transition: none !important; }
    [data-inkling-field], [data-inkling-section], [data-inkling-shared] { cursor: pointer; }
    [data-inkling-shared]:hover, [data-inkling-field]:hover { outline: 2px dashed #3d5afe; outline-offset: 3px; }
    [data-inkling-selected] { outline: 3px solid #3d5afe !important; outline-offset: -3px; }
    [data-inkling-hidden] { opacity: .4 !important; }
    [data-inkling-field]:focus-visible, [data-inkling-shared]:focus-visible, [data-inkling-section]:focus-visible { outline: 3px solid #3d5afe; }
  `
  doc.head.append(style)
  const policy = doc.createElement("meta")
  policy.httpEquiv = "Content-Security-Policy"
  policy.content = `default-src 'none'; script-src 'sha256-${BRIDGE_HASH}'; style-src 'unsafe-inline' http: https:; img-src http: https: data:; font-src http: https: data:; media-src http: https: data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'`
  const setup = doc.createElement("meta")
  setup.name = "inkling-preview"
  setup.content = JSON.stringify({ channel, origin })
  doc.head.prepend(policy, setup)
  const script = doc.createElement("script")
  script.textContent = BRIDGE
  doc.body.append(script)
  return `<!doctype html>${doc.documentElement.outerHTML}`
}
