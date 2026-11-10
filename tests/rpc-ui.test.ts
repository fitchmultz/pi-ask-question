import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";
import type { AskQuestionDetails } from "../extensions/lib/types.ts";
import { isRecord } from "../extensions/lib/validate.ts";
import { startModelEndpoint } from "./model-endpoint.ts";

/** One JSON event line emitted by the RPC CLI subprocess. */
type RpcEvent = {
  type: string;
  id?: string;
  method?: string;
  message?: string;
  options?: string[];
  data?: { disposition?: string };
  success?: boolean;
};

/** Shape check for a parsed RPC event line. */
function isRpcEvent(value: unknown): value is RpcEvent {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

/** Shape check for ask_question details in a notify message. */
function isAskDetails(value: unknown): value is AskQuestionDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    "cancelled" in value &&
    typeof value.cancelled === "boolean" &&
    "timedOut" in value &&
    typeof value.timedOut === "boolean" &&
    "questions" in value &&
    Array.isArray(value.questions) &&
    "answers" in value &&
    Array.isArray(value.answers)
  );
}

/** Parse a notify message as ask_question details. */
function notifyDetails(event: RpcEvent): AskQuestionDetails {
  assert.ok(event.message !== undefined, "notify event must carry a message");
  const parsed: unknown = JSON.parse(event.message);
  assert.ok(isAskDetails(parsed), "notify message must carry ask_question details");
  return parsed;
}

const extension = fileURLToPath(new URL("../extensions/ask-question.ts", import.meta.url));

/** Start the bundled CLI in RPC mode with one fixture extension. The caller is the RPC client. */
function startRpc(fixtureSource: string, cliArgs: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "pi-ask-rpc-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const fixture = join(root, "probe.ts");
  writeFileSync(fixture, fixtureSource);
  const packageDir = join(
    dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
    "..",
  );
  const cli = process.env.PI_HOST_CLI ?? join(packageDir, "dist", "bundle", "cli.js");
  const child = spawn(
    process.execPath,
    [
      cli,
      "--mode",
      "rpc",
      "--no-session",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "-e",
      fixture,
      ...cliArgs,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
        PI_PACKAGE_DIR: packageDir,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const events: RpcEvent[] = [];
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data: string) => {
    stdout += data;
    let newline: number;
    while ((newline = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (line.trim() !== "") {
        const parsed: unknown = JSON.parse(line);
        assert.ok(isRpcEvent(parsed), `RPC line is not an event: ${line}`);
        events.push(parsed);
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (data: string) => {
    stderr += data;
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const wait = async (predicate: (event: RpcEvent) => boolean, after = 0) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const event = events.slice(after).find(predicate);
      if (event !== undefined) {
        return event;
      }
      assert.equal(child.exitCode, null, `RPC process exited: ${stderr}`);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    assert.fail(`RPC event timed out: ${stderr}\n${JSON.stringify(events.slice(after))}`);
  };
  return {
    events,
    send,
    wait,
    ui: (method: string, after: number) =>
      wait((event) => event.type === "extension_ui_request" && event.method === method, after),
    respond: (request: RpcEvent, value?: string) =>
      send({
        type: "extension_ui_response",
        id: request.id,
        ...(value === undefined ? { cancelled: true } : { value }),
      }),
    stop: async () => {
      child.stdin.end();
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
        } else {
          child.once("exit", () => resolve());
        }
      });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// A command invokes the real registered tool without needing a provider call.
// The subprocess still owns the RPC UI protocol, cancellation and command receipt.
nodeTest(
  "bundled CLI RPC dialogs answer, cancel and recover after reload",
  { timeout: 20_000 },
  async () => {
    const { events, send, wait, ui, respond, stop } = startRpc(`
    import askQuestion from ${JSON.stringify(extension)};
    export default function (pi) {
      let tool;
      pi.registerCommand("qa-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
      askQuestion({ ...pi, registerTool(value) { tool = value; pi.registerTool(value); } });
      pi.registerCommand("qa-ask", { handler: async (args, ctx) => {
        const result = await tool.execute("rpc-probe", {
          question: "Which scope?", options: ["Small", "Complete"], multiSelect: args === "multi"
        }, undefined, undefined, ctx);
        ctx.ui.notify(JSON.stringify(result.details), "info");
      }});
    }
  `);
    try {
      let start = events.length;
      send({ id: "multi", type: "prompt", message: "/qa-ask multi" });
      let request = await ui("select", start);
      assert.ok(request.options !== undefined);
      assert.deepEqual(request.options, ["☐ Small", "☐ Complete", "Type a custom answer"]);
      start = events.length;
      respond(request, "☐ Small");
      request = await ui("select", start);
      assert.ok(request.options !== undefined);
      assert.ok(request.options.includes("☑ Small"));
      start = events.length;
      respond(request, "Type a custom answer");
      request = await ui("input", start);
      start = events.length;
      respond(request, "界🙂 custom");
      request = await ui("select", start);
      assert.ok(request.options !== undefined);
      assert.ok(request.options.includes("☑ 界🙂 custom"));
      start = events.length;
      respond(request, "Done selecting");
      const answered = notifyDetails(await ui("notify", start));
      assert.ok(answered.answers[0] !== undefined);
      assert.deepEqual(answered.answers[0].selectedOptions, ["Small", "界🙂 custom"]);
      assert.equal(answered.cancelled, false);
      assert.equal(
        (await wait((event) => event.type === "response" && event.id === "multi")).data
          ?.disposition,
        "handled",
      );

      start = events.length;
      send({ id: "cancel", type: "prompt", message: "/qa-ask" });
      request = await ui("select", start);
      start = events.length;
      respond(request);
      assert.equal(notifyDetails(await ui("notify", start)).cancelled, true);
      assert.equal(
        (await wait((event) => event.type === "response" && event.id === "cancel")).success,
        true,
      );

      send({ id: "reload", type: "prompt", message: "/qa-reload" });
      assert.equal(
        (await wait((event) => event.type === "response" && event.id === "reload")).success,
        true,
      );
      start = events.length;
      send({ id: "recover", type: "prompt", message: "/qa-ask" });
      request = await ui("select", start);
      start = events.length;
      respond(request, "Complete");
      const recovered = notifyDetails(await ui("notify", start));
      assert.ok(recovered.answers[0] !== undefined);
      assert.equal(recovered.answers[0].answer, "Complete");
      assert.equal(
        (await wait((event) => event.type === "response" && event.id === "recover")).success,
        true,
      );
    } finally {
      await stop();
    }
  },
);

/** The text of the last tool result in one request to the model. */
function lastToolResult(body: string | undefined): string {
  assert.ok(body !== undefined);
  const request: unknown = JSON.parse(body);
  assert.ok(isRecord(request) && Array.isArray(request.messages));
  const result: unknown = request.messages.findLast(
    (message: unknown) => isRecord(message) && message.role === "tool",
  );
  assert.ok(isRecord(result) && typeof result.content === "string", "No tool result was sent");
  return result.content;
}

/**
 * Have a model call ask_question with these arguments, and act as its user. The model endpoint
 * makes the call, so Pi prepares, converts and validates the arguments before the tool runs. The
 * RPC client is the UI: `choose` checks the choices a user would see, then picks one. Returns the
 * tool result the model received.
 */
async function modelAsks(
  args: unknown,
  user: (choose: (shown: string[], answer: string) => Promise<void>) => Promise<void>,
): Promise<string> {
  const endpoint = await startModelEndpoint();
  endpoint.toolCalls.push({ name: "ask_question", arguments: args });
  const rpc = startRpc(
    `
    import askQuestion from ${JSON.stringify(extension)};
    export default function (pi) {
      pi.registerProvider("probe", {
        baseUrl: ${JSON.stringify(endpoint.url)}, apiKey: "probe-key", api: "openai-completions",
        models: [{ id: "probe", name: "probe", reasoning: false, input: ["text"], contextWindow: 100000,
          maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      });
      askQuestion(pi);
    }
  `,
    ["--provider", "probe", "--model", "probe"],
  );
  try {
    let seen = 0;
    rpc.send({ type: "prompt", message: "Ask me." });
    await user(async (shown, answer) => {
      const request = await rpc.wait(
        (event) =>
          (event.type === "extension_ui_request" && event.method === "select") ||
          event.type === "agent_settled",
        seen,
      );
      if (request.type === "agent_settled") {
        assert.fail(`No question was shown. ${lastToolResult(endpoint.requests.at(-1))}`);
      }
      assert.deepEqual(request.options, [...shown, "Type a custom answer"]);
      seen = rpc.events.length;
      rpc.respond(request, answer);
    });
    await rpc.wait((event) => event.type === "agent_settled", seen);
    return lastToolResult(endpoint.requests.at(-1));
  } finally {
    await rpc.stop();
    await endpoint.close();
  }
}

// The list strings have the form a local model sent them in; the question wording is shortened.
nodeTest(
  "bundled CLI asks with the list a model sent as one JSON string",
  { timeout: 30_000 },
  async (t) => {
    await t.test("options as a JSON list in one string are separate choices", async () => {
      const result = await modelAsks(
        {
          multiSelect: "false",
          options:
            '["Yes — delete the full listed set (~51G)", "Yes — but only the two biggest: pnpm + npm (~41G)", "Skip for now"]',
          question: "Approve deleting rebuildable caches?",
        },
        async (choose) => {
          await choose(
            [
              "Yes — delete the full listed set (~51G)",
              "Yes — but only the two biggest: pnpm + npm (~41G)",
              "Skip for now",
            ],
            "Skip for now",
          );
        },
      );
      assert.equal(result, "User answered: Skip for now");
    });

    await t.test("options as plain text stay one choice", async () => {
      const result = await modelAsks(
        { question: "Delete the caches?", options: "Yes, delete everything" },
        async (choose) => {
          await choose(["Yes, delete everything"], "Yes, delete everything");
        },
      );
      assert.equal(result, "User answered: Yes, delete everything");
    });

    await t.test("options as a JSON list in one string inside a question list", async () => {
      const result = await modelAsks(
        {
          questions: [{ id: "scope", question: "Which scope?", options: '["Small", "Complete"]' }],
        },
        async (choose) => {
          await choose(["Small", "Complete"], "Complete");
        },
      );
      assert.equal(result, "User answered: Complete");
    });

    await t.test("questions as a JSON list in one string are asked in order", async () => {
      const result = await modelAsks(
        {
          questions:
            '[{"id": "cache_deletion", "options": ["Yes — delete the full listed set (~51G)", "Skip for now"], "question": "Approve deleting rebuildable caches?"}, {"id": "m1_sudo", "options": ["I\'ll run it myself", "Skip it"], "question": "How do you want to handle the restart?"}]',
        },
        async (choose) => {
          await choose(["Yes — delete the full listed set (~51G)", "Skip for now"], "Skip for now");
          await choose(["I'll run it myself", "Skip it"], "Skip it");
        },
      );
      assert.equal(result, "User answered:\n- cache_deletion: Skip for now\n- m1_sudo: Skip it");
    });
  },
);
