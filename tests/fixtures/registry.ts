import type { Registry } from "../../src/plugins/index.ts"

// A registry with nothing in it, for the tests that need one only because the
// route they exercise takes it. Tests about plugins build a real one from
// `tests/fixtures/plugins`.
export const noPlugins: Registry = {
  all: () => [],
  get: () => undefined,
  routes: () => [],
  enable: async () => ({ enabled: [] }),
  disable: async () => {},
  reload: async () => {},
}
