import Anthropic from "@anthropic-ai/sdk"
import { createProvider } from "atlas/ai"
import { claudeExtras, type ResolvedCredential } from "./complete.ts"
import { endpointFor } from "./providers.ts"

// Exercise the same streamed tool transport as Inky without giving it site access.
export const probeTools = async (credential: ResolvedCredential): Promise<boolean> => {
  const marker = crypto.randomUUID()
  const prompt = `Call check_connection with marker exactly "${marker}". This is a connection check; do not answer in prose.`
  const schema = {
    type: "object",
    properties: { marker: { type: "string" } },
    required: ["marker"],
    additionalProperties: false,
  }
  if (credential.provider === "anthropic") {
    const client = new Anthropic(
      credential.authKind === "oauth" ? { authToken: credential.secret } : { apiKey: credential.secret },
    )
    const response = await client.beta.messages
      .stream({
        model: credential.model,
        max_tokens: 2048,
        ...claudeExtras(credential),
        messages: [{ role: "user", content: prompt }],
        tools: [
          {
            name: "check_connection",
            description: "Confirm the connection marker without changing anything.",
            input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
          },
        ],
      })
      .finalMessage()
    return response.content.some(
      block =>
        block.type === "tool_use" &&
        block.name === "check_connection" &&
        (block.input as { marker?: string }).marker === marker,
    )
  }
  const provider = createProvider({
    provider: "openai",
    key: credential.secret || "local",
    baseUrl: endpointFor(credential.provider, credential.baseUrl),
  })
  let passed = false
  for await (const chunk of provider.chatStream({
    model: credential.model,
    maxTokens: 2048,
    messages: [{ role: "user", content: prompt }],
    tools: [
      {
        name: "check_connection",
        description: "Confirm the connection marker without changing anything.",
        parameters: schema,
      },
    ],
  })) {
    if (
      chunk.type === "tool_call" &&
      chunk.toolCall?.name === "check_connection" &&
      chunk.toolCall.arguments.marker === marker
    )
      passed = true
  }
  return passed
}
