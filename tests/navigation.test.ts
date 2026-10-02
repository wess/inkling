import { expect, test } from "bun:test"
import type { ContentType, VisualPage } from "../src/web/api.ts"
import { websiteNavigation } from "../src/web/navigation.ts"

const type = (
  name: string,
  label: string,
  kind: ContentType["kind"],
  previewUrl = "",
  pluralLabel = label,
): ContentType => ({
  id: name,
  name,
  label,
  pluralLabel,
  kind,
  previewUrl,
  fields: [],
  description: null,
  icon: null,
  sortOrder: 0,
  ownerPlugin: null,
})

test("Catalog opens its page while Books identifies the items, without changing stored labels", () => {
  const book = type("book", "Book", "collection", "/books/{slug}", "Catalog")
  const pages: Record<string, VisualPage> = {
    bookspage: {
      sections: [
        { id: "shelf", label: "Catalog", selector: ".shelf", fields: [], collection: { type: "book", label: "Books" } },
      ],
    },
    homepage: { sections: [] },
  }
  const result = websiteNavigation(
    [
      type("house", "The house", "single", "/"),
      type("homepage", "Front page", "single", "/"),
      book,
      type("bookspage", "Catalog page", "single", "/books"),
    ],
    pages,
  )
  expect(result.pages.map(item => [item.label, item.type.name])).toEqual([
    ["Front page", "homepage"],
    ["Catalog", "bookspage"],
  ])
  expect(result.content.map(item => [item.label, item.type.name])).toEqual([["Books", "book"]])
  expect(result.shared.map(item => item.type.name)).toEqual(["house"])
  expect(book.pluralLabel).toBe("Catalog")
})

test("sites without visual configuration keep their pages and collections reachable", () => {
  const result = websiteNavigation(
    [
      type("about", "About", "single", "/about"),
      type("post", "Post", "collection", "/posts/{slug}", "Posts"),
      type("site", "Site details", "single"),
    ],
    {},
  )
  expect(result.pages[0]?.label).toBe("About")
  expect(result.content[0]?.label).toBe("Posts")
  expect(result.shared[0]?.label).toBe("Site details")
})
