/** A local OpenAI-compatible model endpoint for tests that run the real Pi CLI or SDK. */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** One tool call the fake model makes, with the arguments exactly as a model would send them. */
export type ScriptedToolCall = { name: string; arguments: unknown };

function isAddressInfo(value: string | AddressInfo | null): value is AddressInfo {
  return typeof value === "object" && value !== null;
}

function chunk(delta: object, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "probe",
    object: "chat.completion.chunk",
    created: 0,
    model: "probe",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** The stream for one request: the next scripted tool call, or the text "ok". */
function reply(call: ScriptedToolCall | undefined, id: string): string[] {
  if (call === undefined) {
    return [chunk({ role: "assistant", content: "ok" }, null), chunk({}, "stop")];
  }
  const toolCall = {
    index: 0,
    id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  };
  return [chunk({ role: "assistant", tool_calls: [toolCall] }, null), chunk({}, "tool_calls")];
}

/**
 * Start the endpoint. It records each request body. It answers a request with the first tool call
 * waiting in `toolCalls`, or with "ok" when none waits.
 */
export async function startModelEndpoint(): Promise<{
  requests: string[];
  toolCalls: ScriptedToolCall[];
  url: string;
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const toolCalls: ScriptedToolCall[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (data: string) => {
      body += data;
    });
    request.on("end", () => {
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const part of reply(toolCalls.shift(), `call_${requests.length}`)) {
        response.write(part);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(isAddressInfo(address));
  return {
    requests,
    toolCalls,
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
