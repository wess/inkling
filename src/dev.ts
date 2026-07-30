import { foreman } from "@atlas/cli"

process.env.NODE_ENV = "development"

await foreman({
  api: "bun --hot src/server.ts",
  web: "bun --hot src/web/serve.ts",
})
