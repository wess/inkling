import { defineConfig, env } from "atlas/config"

const list = (raw: string): readonly string[] =>
  raw
    .split(",")
    .map(part => part.trim())
    .filter(Boolean)

const oauthClient = (prefix: string) => ({
  clientId: env(`AI_OAUTH_${prefix}_CLIENT_ID`, { default: "" }),
  clientSecret: env(`AI_OAUTH_${prefix}_CLIENT_SECRET`, { default: "" }),
  authorizeUrl: env(`AI_OAUTH_${prefix}_AUTHORIZE_URL`, { default: "" }),
  tokenUrl: env(`AI_OAUTH_${prefix}_TOKEN_URL`, { default: "" }),
  scopes: env(`AI_OAUTH_${prefix}_SCOPES`, { parse: list, default: "" }),
})

export const config = defineConfig({
  environment: env("NODE_ENV", { default: "development" }),
  port: env("PORT", { parse: Number, default: "4300" }),
  host: env("HOST", { default: "0.0.0.0" }),
  // The one public origin. Admin, API, delivery, and media all answer here —
  // they are separated by path, not by port. Media on the local driver is
  // stored root-relative and resolved against this, so consuming sites on
  // another origin get a URL they can actually fetch.
  publicUrl: env("PUBLIC_URL", { default: "http://localhost:4300" }),
  deliveryOrigins: env("DELIVERY_ORIGINS", { parse: list, default: "" }),

  // Postgres everywhere, development included. The SQLite driver is still
  // reachable by URL and the tests use it in memory, but it is not a supported
  // store for an install — see .env.example.
  databaseUrl: env("DATABASE_URL", { default: "postgres://postgres:postgres@127.0.0.1:5432/inkling" }),
  dbPool: env("DB_POOL_SIZE", { parse: Number, default: "5" }),

  secret: env("SECRET", { default: "inkling-dev-secret-change-me" }),
  trustedProxies: env("TRUSTED_PROXIES", { parse: list, default: "" }),
  // Webhooks are the one place an operator hands this process a URL and asks it
  // to make a request. Refusing private and loopback addresses stops that being
  // a way to reach a database port or a cloud metadata service from outside; an
  // install whose receiver genuinely is internal turns it back on here.
  allowPrivateNetwork: env("WEBHOOK_ALLOW_PRIVATE", { parse: raw => /^(1|true|yes)$/i.test(raw), default: "false" }),

  storage: {
    driver: env("STORAGE_DRIVER", { default: "local" }),
    localDir: env("STORAGE_LOCAL_DIR", { default: "./uploads" }),
    endpoint: env("S3_ENDPOINT", { default: "" }),
    bucket: env("S3_BUCKET", { default: "" }),
    region: env("S3_REGION", { default: "us-east-1" }),
    accessKey: env("S3_ACCESS_KEY", { default: "" }),
    secretKey: env("S3_SECRET_KEY", { default: "" }),
    publicUrl: env("S3_PUBLIC_URL", { default: "" }),
    prefix: env("S3_PREFIX", { default: "" }),
  },

  maxUploadBytes: env("MAX_UPLOAD_BYTES", { parse: Number, default: "26214400" }),

  pluginDir: env("PLUGIN_DIR", { default: "./plugins" }),
  pluginAutoEnable: env("PLUGIN_AUTOENABLE", { parse: list, default: "" }),

  bootstrap: {
    email: env("BOOTSTRAP_EMAIL", { default: "" }),
    password: env("BOOTSTRAP_PASSWORD", { default: "" }),
    name: env("BOOTSTRAP_NAME", { default: "Owner" }),
  },

  // Connecting a provider by OAuth needs a client the operator registered with
  // that provider, so unlike an API key it cannot be entered in the admin —
  // there is nothing self-hosted software can ship that stands in for a
  // registered redirect URI. Absent a client id, the admin simply doesn't offer
  // the button. Endpoint overrides exist so a provider we ship no defaults for
  // can still be wired up without a release.
  aiOauth: {
    anthropic: oauthClient("ANTHROPIC"),
    openai: oauthClient("OPENAI"),
    ollama: oauthClient("OLLAMA"),
  },
})
