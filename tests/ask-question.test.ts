import assert from "node:assert/strict";
import test from "node:test";
import askQuestion, { normalize } from "../extensions/ask-question.ts";

function fakeHarness() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const entries: unknown[] = [];
  let activeTools = ["ask_question"];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];

  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  const ctx = {
    mode: "tui",
    ui: {
      theme,
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
    theme,
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

test("ask_question is registered sequential so concurrent calls cannot fight for keyboard focus", () => {
  const harness = fakeHarness();
  assert.equal(harness.tools.get("ask_question").executionMode, "sequential");
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

test("ask_question renderCall shows count and ids, renderResult shows answers or cancelled", () => {
  const harness = fakeHarness();
  const tool = harness.tools.get("ask_question");

  const call = tool.renderCall(
    { questions: [{ id: "scope", question: "Scope?", options: ["a"] }, { id: "checks", question: "Checks?", options: ["x", "y"], multiSelect: true }] },
    harness.theme,
    harness.ctx,
  );
  const callOut = call.render(80).join("\n");
  assert.match(callOut, /ask_question/);
  assert.match(callOut, /2 questions/);
  assert.match(callOut, /scope, checks/);

  const cancelled = tool.renderResult(
    { content: [{ type: "text", text: "User cancelled the question." }], details: { questions: [], answers: [], cancelled: true } },
    { expanded: false, isPartial: false },
    harness.theme,
    harness.ctx,
  );
  assert.match(cancelled.render(80).join("\n"), /Cancelled/);

  const answered = tool.renderResult(
    {
      content: [{ type: "text", text: "x" }],
      details: {
        questions: [{ id: "q", question: "Q?", options: [], multiSelect: false }],
        answers: [{ id: "q", question: "Q?", answer: "Yes", wasCustom: false }],
        cancelled: false,
      },
    },
    { expanded: false, isPartial: false },
    harness.theme,
    harness.ctx,
  );
  const out = answered.render(80).join("\n");
  assert.match(out, /q/);
  assert.match(out, /Yes/);
});

test("normalize auto-suffixes duplicate question ids", () => {
  const result = normalize({ questions: [{ id: "x", question: "a?" }, { id: "x", question: "b?" }, { id: "x", question: "c?" }] });
  assert.deepEqual(result.map((q) => q.id), ["x", "x_2", "x_3"]);
});

test("normalize avoids collisions with user-supplied suffixed ids", () => {
  const result = normalize({ questions: [{ id: "x", question: "a?" }, { id: "x_2", question: "b?" }, { id: "x", question: "c?" }] });
  assert.deepEqual(result.map((q) => q.id), ["x", "x_2", "x_3"]);
});

test("grill-me completes on off status", () => {
  const harness = fakeHarness();
  const command = harness.commands.get("grill-me");
  assert.deepEqual(command.getArgumentCompletions("").map((i: any) => i.value).sort(), ["off", "on", "status"]);
  assert.deepEqual(command.getArgumentCompletions("o").map((i: any) => i.value).sort(), ["off", "on"]);
  assert.equal(command.getArgumentCompletions("zzz"), null);
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
  assert.match(result.systemPrompt, /Walk the decision tree/);
  assert.match(result.systemPrompt, /reading local files, docs, tests, or command output/);
  assert.match(result.systemPrompt, /Ask exactly one blocking question at a time/);
  assert.match(result.systemPrompt, /recommended answer as the first option/);

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

test("grill-me skips footer status outside TUI", async () => {
  const harness = fakeHarness();
  await harness.commands.get("grill-me").handler("on", harness.ctx);
  harness.setMode("print");

  const statusesBefore = harness.statuses.length;
  await harness.handlers.get("session_start")({}, harness.ctx);
  assert.equal(harness.statuses.length, statusesBefore);
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
