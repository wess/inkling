import Anthropic from "@anthropic-ai/sdk"
import { createProvider } from "atlas/ai"
import type { ProviderName } from "./providers.ts"
import { endpointFor, PROVIDERS } from "./providers.ts"

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

// ...but only on the models that can refuse in the first place. Classifier
// declines are a property of Fable 5 and Opus 5, so they are the only models
// that publish an `allowed_fallback_models` list, and the only ones the API will
// accept `fallbacks` for at all. Every other model answers the parameter with a
// 400 that names it — `'claude-sonnet-5' does not support the 'fallbacks'
// parameter` — which fails the whole call. Sonnet 5 is this admin's default
// model, so sending it unconditionally took every Claude connection down: the
// assistant, the editorial rewrites, and the connection test alike.
//
// Prefix-matched because a pinned build (`claude-opus-5-20260514`) and an alias
// (`claude-opus-5-latest`) are the same model, and the field takes either. A
// model that gains classifiers later gets no fallback until it is named here,
// which loses the retry rather than the request.
const CLASSIFIER_MODELS = /^claude-(opus-5|fable-5)/

export const fallbackReady = (model: string): boolean => CLASSIFIER_MODELS.test(model)

// The fallback half of a Claude request, present only when the model takes it.
export const fallbackFor = (model: string) => (fallbackReady(model) ? { fallbacks: FALLBACKS } : {})

// An OAuth access token is not an API key: it goes on `Authorization: Bearer`,
// and the endpoint only honours it when the request also opts in to the OAuth
// beta. Both are properties of the credential, so both are decided here rather
// than at each of the call sites below.
const OAUTH_BETA = "oauth-2025-04-20"

// atlas/ai's OpenAI client ends every failure with "Verify OPENAI_API_KEY is set
// and valid", which is wrong and misdirecting for an Ollama connection pointed
// at an entirely different host — the operator goes hunting for a key problem
// that isn't there. Rewritten at this boundary, naming the provider actually
// configured and the endpoint actually called.
export const readable = (error: unknown, credential: ResolvedCredential): Error => {
  const spec = PROVIDERS[credential.provider]
  const raw = String((error as Error)?.message ?? error)
  const message = raw.replace(/\.\s*Verify OPENAI_API_KEY is set and valid\.?/i, "")
  const where = endpointFor(credential.provider, credential.baseUrl)
  return new Error(`${spec.label} rejected the request${where ? ` at ${where}` : ""}: ${message}`)
}

const claudeClient = (credential: ResolvedCredential) =>
  credential.authKind === "oauth"
    ? new Anthropic({ authToken: credential.secret })
    : new Anthropic({ apiKey: credential.secret })

// Only the betas this request actually uses. The fallback beta rides with the
// `fallbacks` parameter and is dropped with it, so a Sonnet request opts into
// nothing it does not send.
export const betasFor = (credential: ResolvedCredential): string[] => [
  ...(fallbackReady(credential.model) ? [FALLBACK_BETA] : []),
  ...(credential.authKind === "oauth" ? [OAUTH_BETA] : []),
]

export const complete = async (credential: ResolvedCredential, request: CompletionRequest): Promise<Completion> => {
  const maxTokens = request.maxTokens ?? 16_000

  if (credential.provider === "anthropic") {
    const response = await claudeClient(credential).beta.messages.create({
      model: credential.model,
      max_tokens: maxTokens,
      betas: betasFor(credential),
      ...fallbackFor(credential.model),
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

  // Both go through the OpenAI-shaped client. Ollama serves a compatible
  // endpoint at /v1 whether it is running locally or as Ollama Cloud, and
  // atlas/ai's own Ollama provider sends no Authorization header — so the cloud
  // is unreachable through it. One client covers both, and the only difference
  // is where it points.
  const provider = createProvider({
    provider: "openai",
    key: credential.secret || "local",
    baseUrl: endpointFor(credential.provider, credential.baseUrl),
  })

  const response = await provider
    .chat({
      model: credential.model,
      maxTokens,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
    })
    .catch(error => {
      throw readable(error, credential)
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
      ...fallbackFor(credential.model),
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
