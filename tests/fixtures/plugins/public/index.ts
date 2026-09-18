import { get, json, pipeline } from "atlas/server"
import { auth, can, definePlugin, requireAuth, requireCan } from "inkling/plugins"

export default definePlugin({
  name: "public",
  version: "1.0.0",
  routes: ctx => [
    get(
      "/account",
      pipeline(
        requireAuth(ctx.db),
        requireCan(can.managePlugins, "manage plugins"),
      )(async c => json(c, 200, { name: auth(c).name })),
    ),
  ],
})
