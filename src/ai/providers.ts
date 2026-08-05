// The providers an operator can connect. Claude is the default and the one the
// assistant is tuned against; the others exist because an operator who already
// pays for a model shouldn't have to buy a second one to use the assistant.
//
// Adding a provider is an entry here plus a branch in ./complete.ts.

export type ProviderName = "anthropic" | "openai" | "ollama"

// Where a provider's authorization-code flow lives, when we know it. This is
// only half of what a connection needs — the other half is a client the
// operator registered with the provider, which is why it comes from the
// environment rather than from here. See ./oauth.ts.
export type OAuthEndpoints = {
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly scopes: readonly string[]
}

export type ProviderSpec = {
  readonly name: ProviderName
  readonly label: string
  readonly defaultModel: string
  // Ollama runs locally and authenticates by not being exposed, so a key would
  // be a field with nothing to put in it.
  readonly needsKey: boolean
  readonly needsBaseUrl: boolean
  readonly models: readonly string[]
  readonly help: string
  // Defaults only. Null means we don't ship endpoints for this provider, not
  // that OAuth is impossible — an operator who has them can supply all three
  // through the environment.
  readonly oauth: OAuthEndpoints | null
}

export const PROVIDERS: Record<ProviderName, ProviderSpec> = {
  anthropic: {
    name: "anthropic",
    label: "Claude",
    defaultModel: "claude-opus-5",
    needsKey: true,
    needsBaseUrl: false,
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    help: "Recommended. Create a key at console.anthropic.com.",
    oauth: {
      authorizeUrl: "https://claude.ai/oauth/authorize",
      tokenUrl: "https://console.anthropic.com/v1/oauth/token",
      scopes: ["user:inference", "user:profile"],
    },
  },
  openai: {
    name: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o",
    needsKey: true,
    needsBaseUrl: false,
    models: ["gpt-4o", "gpt-4o-mini"],
    help: "Create a key at platform.openai.com.",
    oauth: null,
  },
  ollama: {
    name: "ollama",
    label: "Ollama (local)",
    defaultModel: "llama3.1",
    needsKey: false,
    needsBaseUrl: true,
    models: ["llama3.1", "mistral", "qwen2.5"],
    help: "Point at a running Ollama instance, e.g. http://127.0.0.1:11434.",
    oauth: null,
  },
}

export const isProvider = (value: string): value is ProviderName => value in PROVIDERS

// `oauth` here is not "this provider supports OAuth" but "this install can
// start an OAuth flow right now" — the admin uses it to decide whether to offer
// the button at all, rather than offering one that dead-ends in a 409.
export const providerCatalog = (oauthReady: (name: ProviderName) => boolean) =>
  Object.values(PROVIDERS).map(spec => ({
    name: spec.name,
    label: spec.label,
    defaultModel: spec.defaultModel,
    needsKey: spec.needsKey,
    needsBaseUrl: spec.needsBaseUrl,
    models: spec.models,
    help: spec.help,
    oauth: oauthReady(spec.name),
  }))
