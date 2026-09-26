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
  const terminal = { rows: 24, columns: 80 };

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
        customComponent = factory({ requestRender() {}, terminal }, theme, getKeybindings(), (value: unknown) => {
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
    terminal,
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

function promptEvent() {
  const systemPromptOptions: { sections: Record<string, string>; forceSystemPrompt?: string } = { sections: {} };
  return { systemPrompt: "base", systemPromptOptions };
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
  harness.selections.push("Type a custom answer", "☐ A", "☐ B", "Done selecting");
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

test("RPC multi-select lets a user undo a choice before submitting", async () => {
  const harness = fakeHarness();
  harness.setMode("rpc");
  harness.selections.push("☐ A", "☑ A", "☐ B", "Done selecting");

  const result = await harness.tools.get("ask_question").execute(
    "correct-choice", { question: "Which?", options: ["A", "B"], multiSelect: true },
    undefined, undefined, harness.ctx,
  );

  assert.deepEqual(harness.dialogCalls.map((call) => call.options), [
    ["☐ A", "☐ B", "Type a custom answer"],
    ["☑ A", "☐ B", "Type a custom answer", "Done selecting"],
    ["☐ A", "☐ B", "Type a custom answer"],
    ["☐ A", "☑ B", "Type a custom answer", "Done selecting"],
  ]);
  assert.ok(harness.dialogCalls.every((call) => call.title === "Which?"));
  assert.deepEqual(result.details.answers[0]?.selectedOptions, ["B"]);
  assert.equal(result.content[0].text, 'User answered: ["B"]');
});

test("RPC multi-select can remove a custom answer that matches a control label", async () => {
  const harness = fakeHarness();
  harness.setMode("rpc");
  harness.selections.push("Type a custom answer", "☑ Done selecting", "☐ A", "Done selecting");
  harness.inputs.push("Done selecting");

  const result = await harness.tools.get("ask_question").execute(
    "correct-custom", { question: "Which?", options: ["A"], multiSelect: true },
    undefined, undefined, harness.ctx,
  );

  assert.deepEqual(harness.dialogCalls.filter((call) => call.method === "select").map((call) => call.options), [
    ["☐ A", "Type a custom answer"],
    ["☐ A", "☑ Done selecting", "Type a custom answer", "Done selecting"],
    ["☐ A", "Type a custom answer"],
    ["☑ A", "Type a custom answer", "Done selecting"],
  ]);
  assert.deepEqual(result.details.answers[0]?.selectedOptions, ["A"]);
  assert.equal(result.content[0].text, 'User answered: ["A"]');
});

test("ask_question preserves comma-containing multi-select choices in TUI and RPC results", async () => {
  const options = ["A", "B, C", "A, B", "C"];
  const params = { question: "Which parts?", options, multiSelect: true };

  async function choose(mode: "tui" | "rpc", indices: number[]) {
    const harness = fakeHarness();
    harness.setMode(mode);
    const selectedOptions = indices.map((index) => options[index]);
    if (mode === "rpc") harness.selections.push(...selectedOptions.map((option) => `☐ ${option}`), "Done selecting");
    const controller = new AbortController();
    const execution = harness.tools.get("ask_question").execute("commas", params, controller.signal, undefined, harness.ctx);
    try {
      if (mode === "tui") {
        const component = harness.getCustomComponent();
        let cursor = 0;
        for (const index of indices) {
          while (cursor < index) {
            component.handleInput("\u001b[B");
            cursor += 1;
          }
          component.handleInput(" ");
        }
        component.handleInput("\r");
        assert.ok(component.render(80).join("\n").includes(JSON.stringify(selectedOptions)));
        component.handleInput("\r");
      }
      return await execution;
    } finally {
      controller.abort();
    }
  }

  for (const mode of ["tui", "rpc"] as const) {
    const first = await choose(mode, [0, 1]);
    const second = await choose(mode, [2, 3]);
    assert.deepEqual(first.details.answers[0].selectedOptions, ["A", "B, C"]);
    assert.deepEqual(second.details.answers[0].selectedOptions, ["A, B", "C"]);
    assert.equal(first.content[0].text, 'User answered: ["A","B, C"]');
    assert.equal(second.content[0].text, 'User answered: ["A, B","C"]');
  }
});

test("TUI review preserves spaces inside wrapped multi-select choices", async () => {
  for (const choice of ["B, C", "B,C"]) {
    const harness = fakeHarness();
    const controller = new AbortController();
    const execution = harness.tools.get("ask_question").execute(
      "review", { question: "Which parts?", options: ["A", "B, C", "B,C"], multiSelect: true },
      controller.signal, undefined, harness.ctx,
    );
    const component = harness.getCustomComponent();
    component.handleInput(" ");
    component.handleInput("\u001b[B");
    if (choice === "B,C") component.handleInput("\u001b[B");
    component.handleInput(" ");
    component.handleInput("\r");

    try {
      const prefix = "question_1: ";
      const lines = component.render(20);
      const start = lines.findIndex((line: string) => line.startsWith(prefix));
      assert.ok(start >= 0);
      assert.equal(lines.slice(start, start + 2).map((line: string) => line.slice(prefix.length)).join(""), JSON.stringify(["A", choice]));
    } finally {
      controller.abort();
      await execution;
    }
  }
});

test("TUI review keeps wide choices visible when the answer indent leaves one column", async () => {
  for (const [id, width] of [["question_1", 13], ["abcdefghijklmnopq", 20]] as const) {
    const harness = fakeHarness();
    const controller = new AbortController();
    const execution = harness.tools.get("ask_question").execute(
      "wide-review", { questions: [{ id, question: "Which?", options: ["漢"], multiSelect: true }] },
      controller.signal, undefined, harness.ctx,
    );
    const component = harness.getCustomComponent();
    component.handleInput(" ");
    component.handleInput("\r");
    try {
      const lines = component.render(width);
      assert.ok(lines.some((line: string) => line.includes("漢")));
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
    } finally {
      controller.abort();
      await execution;
    }
  }
});

test("TUI tool result distinguishes choices whose spaces fall on a wrap", async () => {
  const withSpace = "XXXXXXXXXXXXX, C";
  const withoutSpace = "XXXXXXXXXXXXX,C";

  async function rendered(choice: string) {
    const harness = fakeHarness();
    harness.setMode("rpc");
    harness.selections.push("☐ A", `☐ ${choice}`, "Done selecting");
    const tool = harness.tools.get("ask_question");
    const result = await tool.execute(
      "result", { question: "Which?", options: ["A", withSpace, withoutSpace], multiSelect: true },
      undefined, undefined, harness.ctx,
    );
    return tool.renderResult(result, { expanded: false, isPartial: false }, harness.theme, harness.ctx).render(20);
  }

  assert.notDeepEqual(await rendered(withSpace), await rendered(withoutSpace));
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

  controller.abort();
  assert.equal(harness.dialogCalls[0]?.signal?.aborted, true);
  assert.equal(result.details.cancelled, true);
  assert.equal(result.details.timedOut, false);
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

test("ask_question keeps the question and selected wrapped option visible on short and resized terminals", async () => {
  const harness = fakeHarness();
  const options = Array.from({ length: 30 }, (_, index) => `Choice ${index + 1}`);
  options[15] = "A detailed choice with enough explanation to wrap across multiple rows while keeping its final words visible: tail marker";
  const controller = new AbortController();
  const execution = harness.tools.get("ask_question").execute(
    "long-list", { question: "Which choice should I use?", options }, controller.signal, undefined, harness.ctx,
  );
  const component = harness.getCustomComponent();
  const visible = () => component.render(80).slice(-harness.terminal.rows);
  const assertSelection = (label: string) => {
    const rendered = component.render(80);
    assert.ok(rendered.length <= harness.terminal.rows, `Question UI uses ${rendered.length} of ${harness.terminal.rows} available rows`);
    const screen = visible().join("\n");
    assert.match(screen, /Which choice should I use\?/);
    assert.ok(screen.includes(label), `${label} must remain in the native viewport`);
  };

  try {
    assertSelection("> 1. Choice 1");
    for (let index = 0; index < 16; index += 1) component.handleInput("\u001b[B");
    assertSelection("> 17. Choice 17");
    component.handleInput("\u001b[A");
    assertSelection("> 16. A detailed choice");
    assert.match(visible().join("\n"), /tail marker/, "The whole selected wrapped label remains readable");

    harness.terminal.rows = 15;
    assertSelection("> 16. A detailed choice");
    assert.match(visible().join("\n"), /tail marker/);
    harness.terminal.rows = 24;
    assertSelection("> 16. A detailed choice");

    for (let index = 0; index < 14; index += 1) component.handleInput("\u001b[B");
    assertSelection("> 30. Choice 30");
    component.handleInput("\r");
    assert.equal((await execution).details.answers[0]?.answer, "Choice 30");
  } finally {
    controller.abort();
    await execution;
  }
});

test("ask_question previews only selected answers after deselecting a matching custom value", async () => {
  const harness = fakeHarness();
  const controller = new AbortController();
  const execution = harness.tools.get("ask_question").execute(
    "preview", { question: "Choose?", options: ["A", "B"], multiSelect: true }, controller.signal, undefined, harness.ctx,
  );
  const component = harness.getCustomComponent();
  try {
    // Enter custom A, select B, then deselect the predefined A.
    for (const key of ["\u001b[B", "\u001b[B", "\r", "A", "\r", "\u001b[A", " ", "\u001b[A", " "]) {
      component.handleInput(key);
    }
    assert.ok(component.render(80).includes("Current answer: B"));
    component.handleInput("\u001b[C");
    component.handleInput("\r");
    assert.equal((await execution).details.answers[0]?.answer, "B");
  } finally {
    controller.abort();
    await execution;
  }
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
  controller.abort();
  const result = await execution;

  assert.equal(result.details.cancelled, true);
  assert.equal(harness.getCustomDoneCalls(), 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  harness.getCustomComponent().dispose();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

function pendingDialog(_title: string, _options?: string[] | string, opts?: { signal?: AbortSignal }): Promise<undefined> {
  return new Promise((resolve) => {
    if (opts?.signal?.aborted) resolve(undefined);
    else opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}

test("ask_question returns the AFK reply at exactly five minutes without choosing an option", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = fakeHarness();
  const controller = new AbortController();
  const tool = harness.tools.get("ask_question");
  const execution = tool.execute("timeout", { question: "Choose?", options: ["First", "Second"] }, controller.signal, undefined, harness.ctx);
  const component = harness.getCustomComponent();

  t.mock.timers.tick(299_999);
  assert.equal(harness.getCustomDoneCalls(), 0);
  t.mock.timers.tick(1);
  assert.equal(harness.getCustomDoneCalls(), 1);
  const result = await execution;
  assert.match(component.render(80).join("\n"), /Auto-continues after 5 minutes/);

  assert.deepEqual(result.details.answers, []);
  assert.equal(result.details.timedOut, true);
  assert.equal(result.details.cancelled, false);
  assert.equal(controller.signal.aborted, false);
  assert.equal(result.content[0].text, "Timed out after 5 minutes. Mitch is currently AFK. Use your best judgement to choose the option Mitch would choose.");
  const rendered = tool.renderResult(result, { expanded: false, isPartial: false }, harness.theme, harness.ctx).render(80).join("\n");
  assert.match(rendered, /Timed out after 5 minutes/);
  assert.match(rendered, /AFK/);
  assert.doesNotMatch(rendered, /Cancelled|✓|User answered/);
  controller.abort();
  t.mock.timers.tick(300_000);
  assert.equal(harness.getCustomDoneCalls(), 1);
});

test("ask_question preserves saved TUI answers and multi-select choices but not unfinished typing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = fakeHarness();
  const execution = harness.tools.get("ask_question").execute("partial", {
    questions: [
      { question: "First?", options: ["A"] },
      { question: "Second?", options: ["B"], multiSelect: true },
    ],
  }, undefined, undefined, harness.ctx);
  const component = harness.getCustomComponent();
  t.mock.timers.tick(200_000);
  component.handleInput("\r");
  component.handleInput(" ");
  component.handleInput("\u001b[B");
  component.handleInput("\r");
  component.handleInput("Unfinished draft");
  t.mock.timers.tick(100_000);
  assert.equal(harness.getCustomDoneCalls(), 1);
  const result = await execution;

  assert.equal(result.details.timedOut, true);
  assert.deepEqual(result.details.answers.map((answer: any) => answer.answer), ["A", "B"]);
  assert.match(result.content[0].text, /Answers already provided:\n- question_1: A\n- question_2: \["B"\]/);
  assert.doesNotMatch(result.content[0].text, /Unfinished draft/);
});

test("ask_question shares one RPC timeout across custom input and multi-select dialogs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = fakeHarness();
  harness.setMode("rpc");
  harness.selections.push("Type a custom answer", "☐ B");
  harness.inputs.push("Typed answer");
  const select = harness.ctx.ui.select;
  const input = harness.ctx.ui.input;
  let pendingSignal: AbortSignal | undefined;
  harness.ctx.ui.select = async (...args) => {
    if (!harness.selections.length) {
      pendingSignal = args[2]?.signal;
      return pendingDialog(...args);
    }
    t.mock.timers.tick(120_000);
    return select(...args);
  };
  harness.ctx.ui.input = async (...args) => {
    t.mock.timers.tick(50_000);
    return input(...args);
  };
  const execution = harness.tools.get("ask_question").execute("rpc-partial", {
    questions: [{ question: "First?" }, { question: "Second?", options: ["B", "C"], multiSelect: true }],
  }, new AbortController().signal, undefined, harness.ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(pendingSignal);
  t.mock.timers.tick(9_999);
  assert.equal(pendingSignal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(pendingSignal.aborted, true);
  const result = await execution;

  assert.equal(result.details.timedOut, true);
  assert.equal(result.details.cancelled, false);
  assert.deepEqual(result.details.answers.map((answer: any) => answer.answer), ["Typed answer", "B"]);
  assert.equal(getEventListeners(pendingSignal, "abort").length, 0);
});

test("ask_question times out RPC custom input and lets caller cancellation take precedence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const cancel of [false, true]) {
    const harness = fakeHarness();
    harness.setMode("rpc");
    harness.selections.push("Type a custom answer");
    let pendingSignal: AbortSignal | undefined;
    harness.ctx.ui.input = async (...args) => {
      pendingSignal = args[2]?.signal;
      return pendingDialog(...args);
    };
    const controller = new AbortController();
    const execution = harness.tools.get("ask_question").execute("rpc-input", { question: "Details?" }, controller.signal, undefined, harness.ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(300_000);
    assert.equal(pendingSignal?.aborted, true);
    if (cancel) controller.abort();
    const result = await execution;

    assert.equal(result.details.timedOut, !cancel);
    assert.equal(result.details.cancelled, cancel);
    assert.deepEqual(result.details.answers, []);
    if (cancel) assert.equal(result.content[0].text, "User cancelled the question.");
    else assert.match(result.content[0].text, /Mitch is currently AFK/);
  }
});

test("ask_question clears its timer after an answer, cancellation, or UI error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clearTimer = t.mock.method(globalThis, "clearTimeout");
  for (const key of ["\r", "\u001b"]) {
    const harness = fakeHarness();
    const execution = harness.tools.get("ask_question").execute("early", { question: "Choose?", options: ["A"] }, undefined, undefined, harness.ctx);
    harness.getCustomComponent().handleInput(key);
    const result = await execution;
    assert.equal(result.details.timedOut, false);
    assert.equal(result.details.cancelled, key === "\u001b");
    t.mock.timers.tick(300_000);
    assert.equal(harness.getCustomDoneCalls(), 1);
  }
  const harness = fakeHarness();
  harness.ctx.ui.custom = async () => { throw new Error("UI failed"); };
  await assert.rejects(harness.tools.get("ask_question").execute("error", { question: "Choose?" }, undefined, undefined, harness.ctx), /UI failed/);
  assert.equal(clearTimer.mock.callCount(), 3);
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
    "☐ Type a custom answer",
    "☐ Type a custom answer (2)",
    "☐ Done selecting",
    "☐ Done selecting (2)",
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
    "☐ Type a custom answer",
    "☐ Type a custom answer (2)",
    "☐ Done selecting",
    "☐ Done selecting (2)",
    "Type a custom answer (3)",
  ]);
  assert.deepEqual(harness.dialogCalls.at(-1)?.options, [
    "☑ Type a custom answer", "☑ Type a custom answer (2)", "☑ Done selecting", "☑ Done selecting (2)",
    "Type a custom answer (3)", "Done selecting (3)",
  ]);
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

  const event = promptEvent();
  assert.equal(await harness.handlers.get("before_agent_start")(event, harness.ctx), undefined);
  const guidance = event.systemPromptOptions.sections.grill_me;
  assert.match(guidance, /call ask_question first/);
  assert.match(guidance, /Walk the decision tree/);
  assert.match(guidance, /reading local files, docs, tests, or command output/);
  assert.match(guidance, /Ask exactly one blocking question at a time/);
  assert.match(guidance, /recommended answer as the first option/);

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

  const event = promptEvent();
  await harness.handlers.get("before_agent_start")(event, harness.ctx);
  assert.match(event.systemPromptOptions.sections.grill_me, /call ask_question first/);
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
  let event = promptEvent();
  await harness.handlers.get("before_agent_start")(event, harness.ctx);
  assert.match(event.systemPromptOptions.sections.grill_me, /call ask_question first/);

  harness.setMode("print");
  event = promptEvent();
  await harness.handlers.get("before_agent_start")(event, harness.ctx);
  assert.doesNotMatch(event.systemPromptOptions.sections.grill_me, /call ask_question first/);
  assert.match(event.systemPromptOptions.sections.grill_me, /ask clarifying questions first in normal text/);

  harness.setMode("tui");
  harness.setActiveTools([]);
  event = promptEvent();
  await harness.handlers.get("before_agent_start")(event, harness.ctx);
  assert.doesNotMatch(event.systemPromptOptions.sections.grill_me, /call ask_question first/);
  assert.match(event.systemPromptOptions.sections.grill_me, /ask clarifying questions first in normal text/);
});

test("grill-me still appends to prior full overrides", async () => {
  const harness = fakeHarness();
  await harness.commands.get("grill-me").handler("on", harness.ctx);

  const result = await harness.handlers.get("before_agent_start")({
    systemPrompt: "base",
    systemPromptOptions: { sections: {}, forceSystemPrompt: "base" },
  }, harness.ctx);
  assert.match(result.systemPrompt, /base/);
  assert.match(result.systemPrompt, /call ask_question first/);
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
