import { defineConfig, env } from "@atlas/config"

const list = (raw: string): readonly string[] =>
  raw
    .split(",")
    .map(part => part.trim())
    .filter(Boolean)

export const config = defineConfig({
  environment: env("NODE_ENV", { default: "development" }),
  port: env("PORT", { parse: Number, default: "4300" }),
  host: env("HOST", { default: "0.0.0.0" }),
  webPort: env("WEB_PORT", { parse: Number, default: "4310" }),
  apiUrl: env("API_URL", { default: "http://localhost:4300" }),
  appUrl: env("APP_URL", { default: "http://localhost:4310" }),
  // Public origin of this API. Media stored on the local driver is addressed
  // relative to it, so consuming sites on another origin get a URL they can
  // actually fetch.
  publicUrl: env("PUBLIC_URL", { default: "http://localhost:4300" }),
  deliveryOrigins: env("DELIVERY_ORIGINS", { parse: list, default: "" }),

  databaseUrl: env("DATABASE_URL", { default: "sqlite://./inkling.db" }),
  dbPool: env("DB_POOL_SIZE", { parse: Number, default: "5" }),

  secret: env("SECRET", { default: "inkling-dev-secret-change-me" }),
  trustedProxies: env("TRUSTED_PROXIES", { parse: list, default: "" }),

  storage: {
    driver: env("STORAGE_DRIVER", { default: "local" }),
    localDir: env("STORAGE_LOCAL_DIR", { default: "./uploads" }),
    endpoint: env("S3_ENDPOINT", { default: "" }),
    bucket: env("S3_BUCKET", { default: "" }),
    region: env("S3_REGION", { default: "us-east-1" }),
    accessKey: env("S3_ACCESS_KEY", { default: "" }),
    secretKey: env("S3_SECRET_KEY", { default: "" }),
    publicUrl: env("S3_PUBLIC_URL", { default: "" }),
  },

  maxUploadBytes: env("MAX_UPLOAD_BYTES", { parse: Number, default: "26214400" }),

  pluginDir: env("PLUGIN_DIR", { default: "./plugins" }),
  pluginAutoEnable: env("PLUGIN_AUTOENABLE", { parse: list, default: "" }),

  bootstrap: {
    email: env("BOOTSTRAP_EMAIL", { default: "" }),
    password: env("BOOTSTRAP_PASSWORD", { default: "" }),
    name: env("BOOTSTRAP_NAME", { default: "Owner" }),
  },
})
