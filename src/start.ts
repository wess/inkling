import { foreman } from "@atlas/cli"

// Production entry: API + admin SPA as one process group, no --hot.
// `src/dev.ts` is the hot-reloading equivalent.
process.env.NODE_ENV ??= "production"

await foreman({
  api: "bun src/server.ts",
  web: "bun src/web/serve.ts",
})
