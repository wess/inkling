import Anthropic from "@anthropic-ai/sdk"
import { createProvider } from "atlas/ai"
import type { ProviderName } from "./providers.ts"

// The one place a model is actually called. Everything above this file deals in
// prompts and credentials; everything below is provider SDK detail.
//
// Claude goes through the official Anthropic SDK. The other providers go through
// atlas/ai's provider abstraction — which is what it exists for — rather than
// being bent into an Anthropic-shaped client.

export type ResolvedCredential = {
  readonly id: string
  readonly provider: ProviderName
  readonly model: string
  readonly secret: string
  readonly baseUrl: string | null
  // An OAuth access token and an API key are both "the secret", but they ride
  // different headers — `x-api-key` versus `Authorization: Bearer` — so the
  // distinction has to survive as far as the client that builds the request.
  readonly authKind: "key" | "oauth"
}

export type CompletionRequest = {
  readonly system: string
  readonly prompt: string
  // Long-form generation streams; short answers don't need to.
  readonly maxTokens?: number
}

export type Completion = {
  readonly text: string
  readonly provider: ProviderName
  readonly model: string
  // Claude's safety classifiers can decline a request. That arrives as a
  // successful response with an empty body, not an error, so it gets its own
  // flag instead of being mistaken for an empty answer.
  readonly refused: boolean
}

// Refusals route to Opus 4.8, which carries different classifiers, so a benign
// request that trips a false positive is answered rather than dropped. Pinned
// rather than "default" because one header and one shape work identically on the
// streaming and non-streaming paths below.
const FALLBACK_BETA = "server-side-fallback-2026-06-01"
const FALLBACKS = [{ model: "claude-opus-4-8" }]

// An OAuth access token is not an API key: it goes on `Authorization: Bearer`,
// and the endpoint only honours it when the request also opts in to the OAuth
// beta. Both are properties of the credential, so both are decided here rather
// than at each of the call sites below.
const OAUTH_BETA = "oauth-2025-04-20"

const claudeClient = (credential: ResolvedCredential) =>
  credential.authKind === "oauth"
    ? new Anthropic({ authToken: credential.secret })
    : new Anthropic({ apiKey: credential.secret })

const betasFor = (credential: ResolvedCredential): string[] =>
  credential.authKind === "oauth" ? [FALLBACK_BETA, OAUTH_BETA] : [FALLBACK_BETA]

export const complete = async (credential: ResolvedCredential, request: CompletionRequest): Promise<Completion> => {
  const maxTokens = request.maxTokens ?? 16_000

  if (credential.provider === "anthropic") {
    const response = await claudeClient(credential).beta.messages.create({
      model: credential.model,
      max_tokens: maxTokens,
      betas: betasFor(credential),
      fallbacks: FALLBACKS,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
    })

    // Guard before reading content: a refusal returns an empty content array.
    if (response.stop_reason === "refusal") {
      return { text: "", provider: credential.provider, model: response.model, refused: true }
    }

    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map(block => block.text)
      .join("")

    return { text, provider: credential.provider, model: response.model, refused: false }
  }

  // Branched rather than spread: the config is a discriminated union, because
  // Ollama has no key and OpenAI requires one.
  const provider =
    credential.provider === "openai"
      ? createProvider({ provider: "openai", key: credential.secret, baseUrl: credential.baseUrl || undefined })
      : createProvider({ provider: "ollama", baseUrl: credential.baseUrl || undefined })

  const response = await provider.chat({
    model: credential.model,
    maxTokens,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.prompt },
    ],
  })

  return { text: response.content, provider: credential.provider, model: credential.model, refused: false }
}

// Text deltas as they arrive. The admin assistant streams because a rewrite of a
// long field otherwise looks like a hung request for thirty seconds.
export async function* completeStream(
  credential: ResolvedCredential,
  request: CompletionRequest,
): AsyncGenerator<string> {
  const maxTokens = request.maxTokens ?? 64_000

  if (credential.provider === "anthropic") {
    const stream = claudeClient(credential).beta.messages.stream({
      model: credential.model,
      max_tokens: maxTokens,
      betas: betasFor(credential),
      fallbacks: FALLBACKS,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
    })

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text
    }

    // A mid-stream refusal has already yielded whatever preceded it; say so
    // rather than letting a truncated answer read as a complete one.
    const final = await stream.finalMessage()
    if (final.stop_reason === "refusal") yield "\n\n[The model declined to continue this request.]"
    return
  }

  // No streaming path for the other providers yet — one chunk is still correct,
  // just less pleasant, and the caller's SSE framing does not change.
  const once = await complete(credential, { ...request, maxTokens })
  if (once.text) yield once.text
}
