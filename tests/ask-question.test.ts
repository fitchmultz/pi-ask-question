import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { CURSOR_MARKER, getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import askQuestion, { normalize } from "../extensions/ask-question.ts";

function fakeHarness() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const entries: unknown[] = [];
  let activeTools = ["ask_question"];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const selections: Array<string | undefined> = [];
  const inputs: Array<string | undefined> = [];
  const dialogCalls: Array<{ method: string; title: string; options?: string[]; signal?: AbortSignal }> = [];
  let customComponent: any;
  let customDoneCalls = 0;

  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      select: async (title: string, options: string[], opts?: { signal?: AbortSignal }) => {
        dialogCalls.push({ method: "select", title, options, signal: opts?.signal });
        return selections.shift();
      },
      input: async (title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) => {
        dialogCalls.push({ method: "input", title, signal: opts?.signal });
        return inputs.shift();
      },
      custom: (factory: any) => new Promise((resolve) => {
        customComponent = factory({ requestRender() {}, terminal: { rows: 24, columns: 80 } }, theme, getKeybindings(), (value: unknown) => {
          customDoneCalls += 1;
          resolve(value);
        });
      }),
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
    selections,
    inputs,
    dialogCalls,
    getCustomComponent: () => customComponent,
    getCustomDoneCalls: () => customDoneCalls,
    setMode: (mode: string) => {
      ctx.mode = mode;
      ctx.hasUI = mode === "tui" || mode === "rpc";
    },
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

test("ask_question refuses modes without UI", async () => {
  const harness = fakeHarness();
  const tool = harness.tools.get("ask_question");
  harness.setMode("print");

  await assert.rejects(
    tool.execute("call_1", { question: "Continue?", options: ["Yes"] }, undefined, undefined, harness.ctx),
    /needs Pi TUI or RPC UI support/,
  );
});

test("ask_question uses sequential RPC dialogs and supports custom and multi-select answers", async () => {
  const harness = fakeHarness();
  const tool = harness.tools.get("ask_question");
  harness.setMode("rpc");
  harness.selections.push("Type a custom answer", "A", "B", "Done selecting");
  harness.inputs.push("custom value");

  const result = await tool.execute(
    "call_1",
    { questions: [
      { id: "one", question: "First?" },
      { id: "many", question: "Second?", options: ["A", "B"], multiSelect: true },
    ] },
    undefined,
    undefined,
    harness.ctx,
  );

  assert.deepEqual(harness.dialogCalls.map((call) => `${call.method}:${call.title}`), [
    "select:First?", "input:First?", "select:Second?", "select:Second?", "select:Second?",
  ]);
  assert.deepEqual(result.details.answers.map((answer: any) => answer.answer), ["custom value", "A, B"]);
  assert.equal(result.details.cancelled, false);
});

test("ask_question retries RPC option selection after blank custom input", async () => {
  const harness = fakeHarness();
  const tool = harness.tools.get("ask_question");
  harness.setMode("rpc");
  harness.selections.push("Type a custom answer", "A");
  harness.inputs.push("   ");

  const result = await tool.execute(
    "call_1", { question: "Continue?", options: ["A"] }, undefined, undefined, harness.ctx,
  );

  assert.deepEqual(harness.dialogCalls.map((call) => call.method), ["select", "input", "select"]);
  assert.equal(result.details.answers[0]?.answer, "A");
  assert.equal(result.details.cancelled, false);
});

test("ask_question reports RPC cancellation and forwards the abort signal", async () => {
  const harness = fakeHarness();
  const tool = harness.tools.get("ask_question");
  harness.setMode("rpc");
  harness.selections.push(undefined);
  const controller = new AbortController();

  const result = await tool.execute("call_1", { question: "Continue?" }, controller.signal, undefined, harness.ctx);

  assert.equal(harness.dialogCalls[0]?.signal, controller.signal);
  assert.equal(result.details.cancelled, true);
  assert.match(result.content[0].text, /cancelled/);
});

test("ask_question returns TUI cancellation when already aborted", async () => {
  const harness = fakeHarness();
  const controller = new AbortController();
  controller.abort();

  const result = await harness.tools.get("ask_question").execute(
    "call_1", { question: "Continue?" }, controller.signal, undefined, harness.ctx,
  );

  assert.equal(result.details.cancelled, true);
});

test("ask_question reflows after terminal resize and forwards focus to its editor", async () => {
  const harness = fakeHarness();
  const execution = harness.tools.get("ask_question").execute(
    "call_1",
    { questions: [
      { id: "this_identifier_is_far_too_long", question: "漢🙂 A deliberately long question that must wrap when the terminal becomes narrow?" },
      { id: "second", question: "Second question?" },
    ] },
    undefined,
    undefined,
    harness.ctx,
  );

  const component = harness.getCustomComponent();
  const assertFits = (width: number) => {
    const overflow = component.render(width).filter((line: string) => visibleWidth(line) > width);
    assert.deepEqual(overflow, []);
  };
  const narrowWidths = [20, 13, 11, 3, 2, 1];

  component.render(80);
  for (const width of narrowWidths) assertFits(width);

  component.handleInput("\u001b[C");
  component.handleInput("\u001b[C");
  for (const width of narrowWidths) assertFits(width);

  component.handleInput("\u001b[C");
  component.focused = true;
  component.handleInput("\r");
  component.handleInput("漢🙂");
  for (const width of narrowWidths) assertFits(width);
  assert.ok(component.render(1).some((line: string) => line.includes(CURSOR_MARKER)));
  assert.ok(component.render(20).some((line: string) => line.includes(CURSOR_MARKER)));
  component.focused = false;
  assert.ok(component.render(20).every((line: string) => !line.includes(CURSOR_MARKER)));
  component.focused = true;
  assert.ok(component.render(20).some((line: string) => line.includes(CURSOR_MARKER)));
  component.handleInput("\u001b");
  component.handleInput("\u001b");
  await execution;
});

test("ask_question keeps wide options and answered review within narrow widths", async () => {
  const harness = fakeHarness();
  const execution = harness.tools.get("ask_question").execute(
    "call_1",
    { questions: [
      { question: "First?", options: ["漢🙂 option"] },
      { question: "Second?", options: ["Yes"] },
    ] },
    undefined,
    undefined,
    harness.ctx,
  );
  const component = harness.getCustomComponent();
  const assertFits = (width: number) => {
    assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
  };

  for (const width of [3, 2, 1]) assertFits(width);
  component.handleInput("\r");
  component.handleInput("\r");
  for (const width of [3, 2, 1]) assertFits(width);
  component.handleInput("\u001b");
  await execution;
});

test("ask_question shows and honors configured editor bindings", async () => {
  const originalKeybindings = getKeybindings();
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.input.submit": "ctrl+s",
    "tui.select.confirm": "ctrl+y",
    "tui.select.cancel": "ctrl+x",
  }));

  try {
    const harness = fakeHarness();
    const execution = harness.tools.get("ask_question").execute(
      "call_1", { question: "Choose?", options: ["First", "Second"] }, undefined, undefined, harness.ctx,
    );
    const component = harness.getCustomComponent();
    component.handleInput("\u001b[B");
    component.handleInput("\u001b[B");
    component.handleInput("\u0019");

    const editingLines = component.render(80);
    assert.match(editingLines.join("\n"), /ctrl\+s save answer/);
    assert.ok(editingLines.every((line: string) => !line.includes("ctrl+y next/submit")));
    component.handleInput("\u0019");
    assert.ok(component.render(80).some((line: string) => line.includes("Your answer:")));
    component.handleInput("\u0018");
    assert.ok(component.render(80).every((line: string) => !line.includes("Your answer:")));
    component.handleInput("\u0019");

    component.handleInput("Custom");
    component.handleInput("\u0013");
    const result = await execution;
    assert.equal(result.details.answers[0].answer, "Custom");

    const cancelledHarness = fakeHarness();
    const cancelledExecution = cancelledHarness.tools.get("ask_question").execute(
      "call_2", { question: "Cancel?" }, undefined, undefined, cancelledHarness.ctx,
    );
    cancelledHarness.getCustomComponent().handleInput("\u0018");
    assert.equal((await cancelledExecution).details.cancelled, true);
  } finally {
    setKeybindings(originalKeybindings);
  }
});

test("ask_question closes active TUI on abort and removes its listener", async () => {
  const harness = fakeHarness();
  const controller = new AbortController();

  const execution = harness.tools.get("ask_question").execute(
    "call_1", { question: "Continue?" }, controller.signal, undefined, harness.ctx,
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);

  controller.abort();
  const result = await execution;

  assert.equal(result.details.cancelled, true);
  assert.equal(harness.getCustomDoneCalls(), 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  harness.getCustomComponent().dispose();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("ask_question prompt guidelines identify the tool", () => {
  const guidelines = fakeHarness().tools.get("ask_question").promptGuidelines;
  assert.ok(guidelines.every((guideline: string) => guideline.includes("ask_question")));
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

test("normalize preserves all nonblank user options", () => {
  const [question] = normalize({
    question: "Pick?",
    options: ["A", "Type a custom answer", "Done selecting", "Done selecting (2)"],
  });
  assert.deepEqual(question.options, ["A", "Type a custom answer", "Done selecting", "Done selecting (2)"]);
});

test("ask_question suffixes RPC controls past user option collisions", async () => {
  const harness = fakeHarness();
  harness.setMode("rpc");
  harness.selections.push(
    "Type a custom answer",
    "Type a custom answer (2)",
    "Done selecting",
    "Done selecting (2)",
    "Done selecting (3)",
  );

  const result = await harness.tools.get("ask_question").execute(
    "call_1",
    {
      question: "Pick?",
      options: ["Type a custom answer", "Type a custom answer (2)", "Done selecting", "Done selecting (2)"],
      multiSelect: true,
    },
    undefined,
    undefined,
    harness.ctx,
  );

  assert.deepEqual(harness.dialogCalls[0]?.options, [
    "Type a custom answer",
    "Type a custom answer (2)",
    "Done selecting",
    "Done selecting (2)",
    "Type a custom answer (3)",
  ]);
  assert.deepEqual(harness.dialogCalls.at(-1)?.options, ["Type a custom answer (3)", "Done selecting (3)"]);
  assert.equal(
    result.details.answers[0]?.answer,
    "Type a custom answer, Type a custom answer (2), Done selecting, Done selecting (2)",
  );
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

test("grill-me uses ask_question with RPC UI and text without UI or an active tool", async () => {
  const harness = fakeHarness();
  await harness.commands.get("grill-me").handler("on", harness.ctx);

  harness.setMode("rpc");
  let result = await harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
  assert.match(result.systemPrompt, /call ask_question first/);

  harness.setMode("print");
  result = await harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
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
