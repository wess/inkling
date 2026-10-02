import { expect, test } from "bun:test"
import { probeTools } from "../src/ai/probe.ts"

test("Inky's connection check requires a correctly assembled tool call, not a fluent text answer", async () => {
  let mode = "text"
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as { messages: { content: string }[]; tools: unknown[] }
      expect(input.tools).toHaveLength(1)
      const marker = input.messages[0]?.content.match(/exactly "([^"]+)"/)?.[1]
      const args = JSON.stringify({ marker: mode === "wrong" ? "wrong" : marker })
      const deltas =
        mode === "text"
          ? [{ content: "I can do that!" }]
          : [
              {
                tool_calls: [
                  { index: 0, id: "probe", function: { name: "check_connection", arguments: args.slice(0, 10) } },
                ],
              },
              { tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }] },
            ]
      return new Response(
        `${deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join("")}data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: mode === "text" ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    const credential = {
      id: "test",
      provider: "ollama" as const,
      model: "fixture",
      authKind: "key" as const,
      secret: "",
      baseUrl: `http://localhost:${server.port}`,
    }
    expect(await probeTools(credential)).toBe(false)
    mode = "tool"
    expect(await probeTools(credential)).toBe(true)
    mode = "wrong"
    expect(await probeTools(credential)).toBe(false)
  } finally {
    server.stop()
  }
})
