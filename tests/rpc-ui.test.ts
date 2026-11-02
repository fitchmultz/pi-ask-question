import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";
import type { AskQuestionDetails } from "../extensions/lib/types.ts";

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

// A command invokes the real registered tool without needing a provider call.
// The subprocess still owns the RPC UI protocol, cancellation and command receipt.
nodeTest(
  "bundled CLI RPC dialogs answer, cancel and recover after reload",
  { timeout: 20_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-ask-rpc-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const fixture = join(root, "probe.ts");
    const extension = fileURLToPath(new URL("../extensions/ask-question.ts", import.meta.url));
    writeFileSync(
      fixture,
      `
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
  `,
    );
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
    const ui = (method: string, after: number) =>
      wait((event) => event.type === "extension_ui_request" && event.method === method, after);
    const respond = (request: RpcEvent, value?: string) =>
      send({
        type: "extension_ui_response",
        id: request.id,
        ...(value === undefined ? { cancelled: true } : { value }),
      });
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
    }
  },
);
