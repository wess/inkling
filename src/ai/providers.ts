// The providers an operator can connect. Claude is the default and the one the
// assistant is tuned against; the others exist because an operator who already
// pays for a model shouldn't have to buy a second one to use the assistant.
//
// Adding a provider is an entry here plus a branch in ./complete.ts.

export type ProviderName = "anthropic" | "openai" | "ollama"

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
  },
  openai: {
    name: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o",
    needsKey: true,
    needsBaseUrl: false,
    models: ["gpt-4o", "gpt-4o-mini"],
    help: "Create a key at platform.openai.com.",
  },
  ollama: {
    name: "ollama",
    label: "Ollama (local)",
    defaultModel: "llama3.1",
    needsKey: false,
    needsBaseUrl: true,
    models: ["llama3.1", "mistral", "qwen2.5"],
    help: "Point at a running Ollama instance, e.g. http://127.0.0.1:11434.",
  },
}

export const isProvider = (value: string): value is ProviderName => value in PROVIDERS

export const providerCatalog = () =>
  Object.values(PROVIDERS).map(spec => ({
    name: spec.name,
    label: spec.label,
    defaultModel: spec.defaultModel,
    needsKey: spec.needsKey,
    needsBaseUrl: spec.needsBaseUrl,
    models: spec.models,
    help: spec.help,
  }))
