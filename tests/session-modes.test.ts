import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";
import type * as PiSdkModule from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isRecord } from "../extensions/lib/validate.ts";
import { startModelEndpoint } from "./model-endpoint.ts";

const extension = fileURLToPath(new URL("../extensions/ask-question.ts", import.meta.url));

/** Names of the tools one recorded request declares to the model. */
function declaredTools(body: string): string[] {
  const request: unknown = JSON.parse(body);
  assert.ok(isRecord(request));
  const tools = request.tools ?? [];
  assert.ok(Array.isArray(tools));
  return tools.map((tool: unknown) => {
    assert.ok(isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string");
    return tool.function.name;
  });
}

/** One JSON event line emitted by the RPC CLI subprocess. */
type RpcEvent = { type: string; id?: string; success?: boolean; data?: Record<string, unknown> };

function isRpcEvent(value: unknown): value is RpcEvent {
  return isRecord(value) && typeof value.type === "string";
}

async function exited(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
}

// Each CLI run sends a real request to a local model endpoint. The request body is what the
// model receives: its tool declarations and its system prompt.
nodeTest(
  "the CLI offers ask_question to the model only in modes that can show a question",
  { timeout: 60_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-ask-modes-"));
    const agentDir = join(root, "agent");
    const sessionDir = join(root, "sessions");
    mkdirSync(agentDir);
    const endpoint = await startModelEndpoint();
    const fixture = join(root, "probe.ts");
    writeFileSync(
      fixture,
      `
    import askQuestion from ${JSON.stringify(extension)};
    export default function (pi) {
      pi.registerProvider("probe", {
        baseUrl: ${JSON.stringify(endpoint.url)}, apiKey: "probe-key", api: "openai-completions",
        models: [{ id: "probe", name: "probe", reasoning: false, input: ["text"], contextWindow: 100000,
          maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      });
      pi.registerCommand("qa-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
      askQuestion(pi);
    }
  `,
    );
    const packageDir = join(
      dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
      "..",
    );
    const cli = process.env.PI_HOST_CLI ?? join(packageDir, "dist", "bundle", "cli.js");
    const run = (args: string[]) =>
      spawn(
        process.execPath,
        [
          cli,
          ...args,
          "--no-approve",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "-e",
          fixture,
          "--provider",
          "probe",
          "--model",
          "probe",
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
    const lastRequest = (): string => {
      const body = endpoint.requests.at(-1);
      assert.ok(body !== undefined);
      return body;
    };
    t.after(async () => {
      await endpoint.close();
      rmSync(root, { recursive: true, force: true });
    });

    for (const mode of [["-p"], ["--mode", "json"]]) {
      await t.test(`${mode.join(" ")} does not offer it`, async () => {
        const sent = endpoint.requests.length;
        const child = run([...mode, "--no-session", "hi"]);
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (data: string) => {
          stderr += data;
        });
        child.stdout.resume();
        child.stdin.end();
        assert.equal(await exited(child), 0, stderr);
        assert.equal(endpoint.requests.length, sent + 1, "One model request");
        assert.ok(declaredTools(lastRequest()).includes("read"), "Other tools stay declared");
        assert.ok(
          !lastRequest().includes("ask_question"),
          "No declaration, tool list entry, or rule line names ask_question",
        );
      });
    }

    await t.test(
      "RPC offers it and keeps it after reload, a new session, a resume and a fork",
      async () => {
        const child = run(["--mode", "rpc", "--session-dir", sessionDir]);
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
        const wait = async (predicate: (event: RpcEvent) => boolean, after: number) => {
          const deadline = Date.now() + 10_000;
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
        let commands = 0;
        const command = async (message: Record<string, unknown>) => {
          const id = `command-${(commands += 1)}`;
          const start = events.length;
          child.stdin.write(`${JSON.stringify({ id, ...message })}\n`);
          const response = await wait(
            (event) => event.type === "response" && event.id === id,
            start,
          );
          assert.equal(response.success, true, JSON.stringify(response));
          return response.data ?? {};
        };
        /** Run one model turn and assert its request offers ask_question with its three rules. */
        const assertOffered = async (when: string) => {
          const sent = endpoint.requests.length;
          const start = events.length;
          await command({ type: "prompt", message: `Turn ${when}` });
          await wait((event) => event.type === "agent_settled", start);
          assert.equal(endpoint.requests.length, sent + 1, `One model request ${when}`);
          assert.ok(declaredTools(lastRequest()).includes("ask_question"), `Declared ${when}`);
          assert.equal(lastRequest().match(/For ask_question,/g)?.length, 3, `Rules sent ${when}`);
        };
        try {
          await assertOffered("in a new session");
          const { sessionFile } = await command({ type: "get_state" });
          assert.ok(typeof sessionFile === "string");

          await command({ type: "prompt", message: "/qa-reload" });
          await assertOffered("after reload");

          await command({ type: "new_session" });
          await assertOffered("after starting another session");

          await command({ type: "switch_session", sessionPath: sessionFile });
          await assertOffered("after resuming the first session");

          const { messages } = await command({ type: "get_fork_messages" });
          assert.ok(Array.isArray(messages));
          const last: unknown = messages.at(-1);
          assert.ok(isRecord(last) && typeof last.entryId === "string");
          await command({ type: "fork", entryId: last.entryId });
          await assertOffered("after a fork");
        } finally {
          child.stdin.end();
          child.kill("SIGTERM");
          await exited(child);
        }
      },
    );
  },
);

/** Run with HOME and the Pi agent directory pointed at a fresh temporary profile. */
async function withIsolatedProfile(
  run: (home: string, agentDir: string) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pi-ask-no-ui-"));
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const previous = {
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await run(home, agentDir);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
}

type PiSdk = typeof PiSdkModule;
type ExtensionFactory = NonNullable<
  NonNullable<
    Parameters<PiSdk["createAgentSessionServices"]>[0]["resourceLoaderOptions"]
  >["extensionFactories"]
>[number];

/** Open an SDK session that loads only the extension under test and the given factories. */
async function openSdkSession(
  pi: PiSdk,
  options: {
    home: string;
    agentDir: string;
    sessionManager: ReturnType<PiSdk["SessionManager"]["inMemory"]>;
    extensionFactories: ExtensionFactory[];
    /** Provider and model id of a model that `extensionFactories` registers. */
    model?: string;
  },
) {
  const { home, agentDir, sessionManager, extensionFactories, model } = options;
  const settingsManager = pi.SettingsManager.inMemory({ quietStartup: true });
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  return pi.createAgentSessionRuntime(
    async ({ cwd, sessionManager: manager }) => {
      const services = await pi.createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          additionalExtensionPaths: [extension],
          extensionFactories,
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      const selected =
        model === undefined ? undefined : services.modelRuntime.getModel(model, model);
      assert.equal(selected === undefined, model === undefined, "The test model is registered");
      return {
        ...(await pi.createAgentSessionFromServices({
          services,
          sessionManager: manager,
          ...(selected === undefined ? {} : { model: selected }),
        })),
        services,
        diagnostics: services.diagnostics,
      };
    },
    { cwd: home, agentDir, sessionManager },
  );
}

// pi-subagents binds its children exactly like this: print mode, no UI context, an error listener.
nodeTest(
  "a session resumed without a UI withdraws ask_question and keeps the journal's other tools",
  { timeout: 20_000 },
  async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("No network in the session test");
    });
    await withIsolatedProfile(async (home, agentDir) => {
      const pi = await import("@earendil-works/pi-coding-agent");
      // The journal of a UI session: it declared ask_question, and a tool that registers after
      // session start, as the tools of a connecting MCP server do.
      const sessionManager = pi.SessionManager.inMemory(home);
      sessionManager.appendMessage({
        role: "system",
        content: "",
        toolsAdded: ["read", "ask_question", "late_tool"].map((name) => ({
          name,
          description: name,
          parameters: Type.Object({}),
        })),
        timestamp: Date.now(),
      });
      const errors: string[] = [];
      const runtime = await openSdkSession(pi, {
        home,
        agentDir,
        sessionManager,
        extensionFactories: [
          (api) => {
            api.registerCommand("connect", {
              handler: async () => {
                api.registerTool({
                  name: "late_tool",
                  label: "Late tool",
                  description: "Registers after session start",
                  exposure: "deferred",
                  parameters: Type.Object({}),
                  execute: async () => ({ content: [], details: {} }),
                });
              },
            });
          },
        ],
      });
      try {
        await runtime.session.bindExtensions({
          mode: "print",
          onError: (error) => {
            errors.push(error.error);
          },
        });
        const assertWithdrawn = (when: string) => {
          assert.ok(!runtime.session.getActiveToolNames().includes("ask_question"), when);
          assert.ok(!runtime.session.systemPrompt.includes("ask_question"), when);
        };
        assertWithdrawn("The resumed session does not offer it");
        assert.ok(runtime.session.getActiveToolNames().includes("read"));

        await runtime.session.prompt("/connect");
        assert.ok(
          runtime.session.getActiveToolNames().includes("late_tool"),
          "A journal tool that registers later is still restored",
        );
        assertWithdrawn("A later tool registration does not bring it back");

        await runtime.session.reload();
        assertWithdrawn("Reload does not bring it back");
        assert.deepEqual(errors, []);
      } finally {
        await runtime.dispose();
      }
    });
  },
);

// Pi announces a session start on bind, and on reload only when the host bound a UI context,
// command actions, a shutdown handler or an error listener. These SDK sessions get neither.
nodeTest(
  "an SDK session without a UI does not offer ask_question when Pi announces no session start",
  { timeout: 20_000 },
  async (t) => {
    const endpoint = await startModelEndpoint();
    t.after(endpoint.close);
    const cases = [
      { name: "never bound", bind: false, reload: false },
      { name: "bound with nothing, then reloaded", bind: true, reload: true },
    ];
    for (const { name, bind, reload } of cases) {
      await t.test(name, async () => {
        await withIsolatedProfile(async (home, agentDir) => {
          const pi = await import("@earendil-works/pi-coding-agent");
          const runtime = await openSdkSession(pi, {
            home,
            agentDir,
            sessionManager: pi.SessionManager.inMemory(home),
            model: "probe",
            extensionFactories: [
              (api) => {
                api.registerProvider("probe", {
                  baseUrl: endpoint.url,
                  apiKey: "probe-key",
                  api: "openai-completions",
                  models: [
                    {
                      id: "probe",
                      name: "probe",
                      reasoning: false,
                      input: ["text"],
                      contextWindow: 100_000,
                      maxTokens: 1000,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                  ],
                });
              },
            ],
          });
          try {
            if (bind) {
              await runtime.session.bindExtensions({});
            }
            if (reload) {
              await runtime.session.reload();
            }
            const sent = endpoint.requests.length;
            await runtime.session.prompt("hi");
            assert.equal(endpoint.requests.length, sent + 1, "One model request");
            const body = endpoint.requests.at(-1) ?? "";
            assert.ok(declaredTools(body).includes("read"), "Other tools stay declared");
            assert.ok(
              !body.includes("ask_question"),
              "No declaration, tool list entry, or rule line names ask_question",
            );
          } finally {
            await runtime.dispose();
          }
        });
      });
    }
  },
);
