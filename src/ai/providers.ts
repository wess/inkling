// The providers an operator can connect. Claude is the default and the one the
// assistant is tuned against; the others exist because an operator who already
// pays for a model shouldn't have to buy a second one to use the assistant.
//
// Adding a provider is an entry here plus a branch in ./complete.ts.

export type ProviderName = "anthropic" | "openai" | "ollama" | "ollamacloud"

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
  // One question, since Ollama Cloud became its own entry. It briefly took two
  // — a shown-but-optional key — back when a single Ollama entry had to serve
  // both the local instance and the hosted one. Splitting them removed the case,
  // and a second flag that always equalled the first was only ever a trap.
  readonly needsKey: boolean
  readonly needsBaseUrl: boolean
  // A fixed endpoint the operator never sees. Set for hosted services that live
  // at exactly one address — asking someone to type it is a field with one
  // correct answer and several plausible wrong ones, which is precisely how
  // `https://ollama.com/v1` ends up requesting `/v1/v1/chat/completions`.
  readonly endpoint?: string
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
    // Sonnet rather than Opus, because Inky's work is bounded — read a few
    // entries, work out which page was meant, propose one change. Sonnet 5
    // reaches near-Opus quality on exactly that shape of tool-calling work at a
    // lower price per token. Opus earns its premium on the long-horizon jobs;
    // an operator who wants it types it in, and the field takes any model.
    defaultModel: "claude-sonnet-5",
    needsKey: true,
    needsBaseUrl: false,
    models: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"],
    help: "Recommended. Create a key at console.anthropic.com. Sonnet 5 is the default and is the right tier for most of Inky's work; Opus 5 is worth the price on the hardest restructuring.",
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
    help: "Create a key at platform.openai.com. Inky works here as well as on Claude — type the model you want; the list is only a starting point, and it has to be one that supports tool calling.",
    oauth: null,
  },
  ollama: {
    name: "ollama",
    label: "Ollama (local)",
    defaultModel: "llama3.1",
    // A local instance authenticates by not being exposed. Ollama Cloud is its
    // own entry below rather than this one with a key pasted in, because the two
    // differ in every field that matters and one form serving both is what made
    // the base URL a guessing game.
    needsKey: false,
    needsBaseUrl: false,
    models: ["llama3.1", "mistral", "qwen2.5"],
    help: "Point at a running instance. Defaults to http://127.0.0.1:11434 if you leave the URL blank. Inky needs a model that supports tool calling.",
    oauth: null,
  },
  ollamacloud: {
    name: "ollamacloud",
    label: "Ollama Cloud",
    // Verify against the model list on your own account — what is hosted there
    // changes, and a name that is merely plausible fails as a 404 at first use.
    defaultModel: "gpt-oss:120b",
    needsKey: true,
    // Fixed at https://ollama.com, so there is no URL to get wrong.
    needsBaseUrl: false,
    endpoint: "https://ollama.com",
    models: [],
    help: "Paste a key from ollama.com. The endpoint is fixed, so there is no URL to enter. Type the model exactly as your account lists it, and pick one that supports tool calling or Inky cannot read your site.",
    oauth: null,
  },
}

// Where an OpenAI-shaped request for this provider goes. An operator-supplied
// base URL wins, then the provider's fixed endpoint, then the client's own
// default — which is api.openai.com, correct for OpenAI and nobody else.
export const endpointFor = (provider: ProviderName, baseUrl: string | null): string | undefined =>
  baseUrl || PROVIDERS[provider].endpoint || (provider === "ollama" ? OLLAMA_LOCAL : undefined)

// Ollama serves an OpenAI-compatible endpoint alongside its native one, and the
// client appends `/v1/chat/completions` itself.
export const OLLAMA_LOCAL = "http://127.0.0.1:11434"

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
