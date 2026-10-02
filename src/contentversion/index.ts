import type { EmitName, Hooks } from "../plugins/hooks.ts"

const CHANGES: readonly EmitName[] = [
  "entry.afterSave",
  "entry.afterPublish",
  "entry.afterUnpublish",
  "entry.afterDelete",
  "media.afterUpload",
  "media.afterSave",
  "media.afterDelete",
  "settings.afterSave",
  "menu.afterSave",
  "menu.afterDelete",
  "design.afterSave",
  "contentType.afterSave",
  "contentType.afterDelete",
  "taxonomy.afterChange",
]

// A host can invalidate its delivery cache without polling or opening a socket.
// Register before plugins so the revision changes even if a later listener stalls.
export const contentVersion = (hooks: Hooks): (() => number) => {
  let version = 0
  for (const name of CHANGES)
    hooks.on(name, "core", () => {
      version += 1
    })
  return () => version
}
