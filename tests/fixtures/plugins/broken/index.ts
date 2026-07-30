import { definePlugin } from "../../../../src/plugins/define.ts"

export default definePlugin({
  name: "broken",
  version: "1.0.0",
  install: () => {
    throw new Error("install failed")
  },
})
