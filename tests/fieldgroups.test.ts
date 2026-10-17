import { expect, test } from "bun:test"
import type { Field } from "../src/web/api.ts"
import { fieldGroups } from "../src/web/fieldgroups.ts"

const field = (key: string, label: string): Field => ({ key, label, type: "text" })

test("section prefixes group adjacent fields without changing their keys", () => {
  const groups = fieldGroups([
    field("browserTitle", "Browser title"),
    field("heroTitle", "Hero — title"),
    field("heroBody", "Hero — body"),
    field("ticker", "Ticker"),
    field("visitHours", "Visit — hours"),
  ])
  expect(groups.map(group => group.name)).toEqual([null, "Hero", null, "Visit"])
  expect(groups[1]?.fields.map(item => [item.field.key, item.label])).toEqual([
    ["heroTitle", "title"],
    ["heroBody", "body"],
  ])
  expect(groups[3]?.fields[0]?.field.label).toBe("Visit — hours")
})
