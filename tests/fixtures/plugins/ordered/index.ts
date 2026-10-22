import { from } from "@wess/atlas/db/query"
import { definePlugin } from "../../../../src/plugins/define.ts"

export default definePlugin({
  name: "ordered",
  version: "1.0.0",
  install: async ctx => {
    await ctx.db.execute(from("ordered_install").insert({ id: "ready" }))
  },
})
