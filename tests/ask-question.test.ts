import assert from "node:assert/strict";
import test from "node:test";
import askQuestion from "../extensions/ask-question.ts";

function fakeHarness() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const entries: unknown[] = [];
  let activeTools = ["ask_question"];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];

  const ctx = {
    mode: "tui",
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
    sessionManager: { getBranch: () => entries },
  };

  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (event: string, handler: any) => handlers.set(event, handler),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    getActiveTools: () => activeTools,
  };

  askQuestion(pi as any);

  return {
    tools,
    commands,
    handlers,
    entries,
    ctx,
    statuses,
    notifications,
    setMode: (mode: string) => { ctx.mode = mode; },
    setActiveTools: (tools: string[]) => { activeTools = tools; },
  };
}

test("registers ask_question tool and grill-me command", () => {
  const harness = fakeHarness();
  assert.ok(harness.tools.has("ask_question"));
  assert.ok(harness.commands.has("grill-me"));
  assert.ok(harness.handlers.has("session_start"));
  assert.ok(harness.handlers.has("session_tree"));
  assert.ok(harness.handlers.has("before_agent_start"));
});

test("ask_question refuses non-TUI mode before opening custom UI", async () => {
  const harness = fakeHarness();
  const tool = harness.tools.get("ask_question");
  harness.setMode("print");

  await assert.rejects(
    tool.execute("call_1", { question: "Continue?", options: ["Yes"] }, undefined, undefined, harness.ctx),
    /needs pi TUI mode/,
  );
});

test("grill-me toggles, persists, and updates footer status", async () => {
  const harness = fakeHarness();
  const command = harness.commands.get("grill-me");

  await command.handler("", harness.ctx);
  assert.deepEqual(harness.entries.at(-1), { type: "custom", customType: "ask-question.grill-me", data: { enabled: true } });
  assert.deepEqual(harness.statuses.at(-1), { key: "ask-question.grill-me", text: "grill-mode" });

  const result = await harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
  assert.match(result.systemPrompt, /base/);
  assert.match(result.systemPrompt, /call ask_question first/);

  await command.handler("off", harness.ctx);
  assert.deepEqual(harness.entries.at(-1), { type: "custom", customType: "ask-question.grill-me", data: { enabled: false } });
  assert.deepEqual(harness.statuses.at(-1), { key: "ask-question.grill-me", text: undefined });
});

test("grill-me restores last valid branch state after reload", async () => {
  const harness = fakeHarness();
  harness.entries.push(
    { type: "custom", customType: "ask-question.grill-me", data: { enabled: false } },
    { type: "custom", customType: "ask-question.grill-me", data: { enabled: "yes" } },
    { type: "custom", customType: "ask-question.grill-me", data: { enabled: true } },
  );

  await harness.handlers.get("session_start")({}, harness.ctx);
  assert.deepEqual(harness.statuses.at(-1), { key: "ask-question.grill-me", text: "grill-mode" });

  const result = await harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
  assert.match(result.systemPrompt, /call ask_question first/);
});

test("grill-me uses text questions outside TUI or when ask_question is inactive", async () => {
  const harness = fakeHarness();
  await harness.commands.get("grill-me").handler("on", harness.ctx);

  harness.setMode("print");
  let result = await harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
  assert.doesNotMatch(result.systemPrompt, /call ask_question first/);
  assert.match(result.systemPrompt, /ask clarifying questions first in normal text/);

  harness.setMode("tui");
  harness.setActiveTools([]);
  result = await harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
  assert.doesNotMatch(result.systemPrompt, /call ask_question first/);
  assert.match(result.systemPrompt, /ask clarifying questions first in normal text/);
});

test("grill-me status and invalid args do not persist new state", async () => {
  const harness = fakeHarness();
  const command = harness.commands.get("grill-me");

  await command.handler("status", harness.ctx);
  assert.equal(harness.entries.length, 0);
  assert.deepEqual(harness.statuses.at(-1), { key: "ask-question.grill-me", text: undefined });

  await command.handler("enabled", harness.ctx);
  assert.equal(harness.entries.length, 0);
  assert.equal(harness.notifications.at(-1)?.type, "warning");
});
