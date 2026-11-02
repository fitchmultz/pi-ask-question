import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { test as nodeTest } from "node:test";
import { Compile } from "typebox/compile";
import type { Static } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import askQuestion from "../extensions/ask-question.ts";
import type { QuestionForm } from "../extensions/lib/question-form.ts";
import type { AskQuestionParams } from "../extensions/lib/schema.ts";
import type { AskQuestionDetails, QuestionResult } from "../extensions/lib/types.ts";

/** The ask_question tool surface the tests exercise. */
type AskTool = {
  readonly name: string;
  readonly parameters: typeof AskQuestionParams;
  readonly executionMode?: string;
  readonly execute: (
    toolCallId: string,
    params: Static<typeof AskQuestionParams>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: unknown,
  ) => Promise<AgentToolResult<AskQuestionDetails>>;
  readonly renderCall: (
    args: Static<typeof AskQuestionParams>,
    theme: unknown,
    context: unknown,
  ) => Component;
  readonly renderResult: (
    result: AgentToolResult<AskQuestionDetails>,
    options: unknown,
    theme: unknown,
    context: unknown,
  ) => Component;
};

type FakeTheme = {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

type FakeTerminal = { rows: number; columns: number };

type FakeTui = {
  readonly requestRender: () => void;
  readonly addInputListener: (listener: (data: string) => unknown) => () => void;
  readonly terminal: FakeTerminal;
};

type FakeCommand = {
  readonly description: string;
  readonly getArgumentCompletions: (
    prefix: string,
  ) => Array<{ value: string; label: string }> | null;
  readonly handler: (args: string, ctx: unknown) => Promise<void>;
};

type FakeEntry = { type: string; customType: string; data: unknown };

type FakeUi = {
  readonly theme: FakeTheme;
  readonly setStatus: (key: string, text: string | undefined) => void;
  readonly setWidget: (key: string, widget: unknown) => void;
  readonly notify: (message: string, type?: string) => void;
  select: (
    this: void,
    title: string,
    options: string[],
    opts?: { signal?: AbortSignal },
  ) => Promise<string | undefined>;
  input: (
    this: void,
    title: string,
    placeholder?: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<string | undefined>;
  custom: (
    factory: (
      tui: FakeTui,
      theme: FakeTheme,
      keys: KeybindingsManager,
      done: (value: QuestionResult) => void,
    ) => QuestionForm,
    options?: { onHandle?: () => void },
  ) => Promise<QuestionResult>;
};

type FakeCtx = {
  mode: string;
  hasUI: boolean;
  ui: FakeUi;
  readonly sessionManager: {
    readonly getBranch: () => FakeEntry[];
    readonly getSessionId: () => string;
  };
};

type EventListener = (...args: unknown[]) => unknown;

type FakePi = {
  readonly registerTool: (tool: AskTool) => void;
  readonly registerCommand: (name: string, command: FakeCommand) => void;
  readonly on: (event: string, handler: EventListener) => () => void;
  readonly events: {
    readonly emit: (channel: string, data: unknown) => void;
    readonly on: (channel: string, handler: (data: unknown) => void) => () => void;
  };
  readonly appendEntry: (customType: string, data: unknown) => void;
  readonly getActiveTools: () => string[];
};

function fakeHarness() {
  const tools = new Map<string, AskTool>();
  const commands = new Map<string, FakeCommand>();
  const handlers = new Map<string, EventListener>();
  const subscriptions = new Map<string, Set<EventListener>>();
  const events = new EventEmitter();
  const entries: FakeEntry[] = [];
  let activeTools = ["ask_question"];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const selections: Array<string | undefined> = [];
  const inputs: Array<string | undefined> = [];
  const dialogCalls: Array<{
    method: string;
    title: string;
    options?: string[];
    signal: AbortSignal | undefined;
  }> = [];
  let customComponent: QuestionForm | undefined;
  let customDoneCalls = 0;

  const theme: FakeTheme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
  };
  const terminal: FakeTerminal = { rows: 24, columns: 80 };

  const ctx: FakeCtx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      setStatus: (key, text) => statuses.push({ key, text }),
      setWidget(_key, _widget) {
        // The harness does not track widget registrations.
      },
      notify: (message, type) => notifications.push({ message, type }),
      select: async (title, options, opts) => {
        dialogCalls.push({ method: "select", title, options, signal: opts?.signal });
        return selections.shift();
      },
      input: async (title, _placeholder, opts) => {
        dialogCalls.push({ method: "input", title, signal: opts?.signal });
        return inputs.shift();
      },
      custom: (factory, options) =>
        new Promise<QuestionResult>((resolve) => {
          customComponent = factory(
            {
              requestRender() {
                // Renders are driven manually by the tests.
              },
              addInputListener: () => () => {
                // The harness registers no input listeners.
              },
              terminal,
            },
            theme,
            getKeybindings(),
            (value) => {
              customDoneCalls += 1;
              resolve(value);
            },
          );
          options?.onHandle?.();
        }),
    },
    sessionManager: { getBranch: () => entries, getSessionId: () => "native-test-root" },
  };

  const pi: FakePi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (event, listener) => {
      let listeners = subscriptions.get(event);
      if (listeners === undefined) {
        listeners = new Set<EventListener>();
        subscriptions.set(event, listeners);
      }
      const registered = listeners;
      registered.add(listener);
      handlers.set(event, (...args) => {
        const results = [...registered].map((entry) => entry(...args));
        return results.find((result) => result !== undefined);
      });
      return () => {
        registered.delete(listener);
        if (registered.size === 0) {
          handlers.delete(event);
        }
      };
    },
    events: {
      emit: (channel, data) => {
        events.emit(channel, data);
      },
      on: (channel, listener) => {
        events.on(channel, listener);
        return () => {
          events.off(channel, listener);
        };
      },
    },
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    getActiveTools: () => activeTools,
  };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-003: the fake implements every ExtensionAPI member askQuestion consumes; the 74-test suite exercises the real extension code through it.
  askQuestion(pi as unknown as ExtensionAPI);

  return {
    tools,
    commands,
    handlers,
    events,
    entries,
    ctx,
    theme,
    terminal,
    statuses,
    notifications,
    selections,
    inputs,
    dialogCalls,
    getCustomComponent: () => {
      assert.ok(customComponent !== undefined);
      return customComponent;
    },
    getCustomDoneCalls: () => customDoneCalls,
    setMode: (mode: string) => {
      ctx.mode = mode;
      ctx.hasUI = mode === "tui" || mode === "rpc";
    },
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
  };
}

type Harness = ReturnType<typeof fakeHarness>;

function askTool(harness: Harness): AskTool {
  const tool = harness.tools.get("ask_question");
  assert.ok(tool !== undefined);
  return tool;
}

function eventHandler(harness: Harness, event: string): EventListener {
  const listener = harness.handlers.get(event);
  assert.ok(listener !== undefined);
  return listener;
}

function grillMeCommand(harness: Harness): FakeCommand {
  const command = harness.commands.get("grill-me");
  assert.ok(command !== undefined);
  return command;
}

function isSystemPromptResult(value: unknown): value is { systemPrompt: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "systemPrompt" in value &&
    typeof value.systemPrompt === "string"
  );
}

function contentText(result: AgentToolResult<AskQuestionDetails>): string {
  const content = result.content[0];
  if (content !== undefined && content.type === "text") {
    return content.text;
  }
  return "";
}

/** A minimal mouse event; only type, button, x, and y affect the form. */
function mouseEvent(type: "press" | "move", x: number, y: number): TuiMouseEvent {
  return {
    type,
    button: type === "press" ? "left" : "none",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

function promptEvent() {
  const systemPromptOptions: { sections: Record<string, string>; forceSystemPrompt?: string } = {
    sections: {},
  };
  return { systemPrompt: "base", systemPromptOptions };
}

function grillMeGuidance(event: ReturnType<typeof promptEvent>): string {
  const guidance = event.systemPromptOptions.sections["grill_me"];
  assert.ok(typeof guidance === "string");
  return guidance;
}

nodeTest("registers ask_question tool and grill-me command", () => {
  const harness = fakeHarness();
  assert.ok(harness.tools.has("ask_question"));
  assert.ok(harness.commands.has("grill-me"));
  assert.ok(harness.handlers.has("session_start"));
  assert.ok(harness.handlers.has("session_tree"));
  assert.ok(harness.handlers.has("before_agent_start"));
});

nodeTest(
  "ask_question is registered sequential so concurrent calls cannot fight for keyboard focus",
  () => {
    const harness = fakeHarness();
    assert.equal(askTool(harness).executionMode, "sequential");
  },
);

nodeTest("ask_question schema accepts supported inputs and rejects malformed arguments", () => {
  const schema = askTool(fakeHarness()).parameters;
  const validator = Compile(schema);
  for (const input of [
    { question: "Which?", options: ["A", "B, C", "界🙂"], multiSelect: true },
    {
      questions: [{ id: "scope", question: "Which?", options: ["Minimal"] }, { question: "Why?" }],
    },
  ]) {
    assert.equal(validator.Check(input), true, JSON.stringify(input));
  }
  for (const input of [
    { question: "" },
    { question: "Which?", options: [""] },
    { question: "Which?", options: [1] },
    { question: "Which?", multiSelect: "yes" },
    { question: "Which?", unexpected: true },
    { questions: [{ id: "scope" }] },
    { questions: [{ question: "Which?", unexpected: true }] },
  ]) {
    assert.equal(validator.Check(input), false, JSON.stringify(input));
  }
});

nodeTest("ask_question refuses modes without UI", async () => {
  const harness = fakeHarness();
  const tool = askTool(harness);
  harness.setMode("print");

  await assert.rejects(
    tool.execute(
      "call_1",
      { question: "Continue?", options: ["Yes"] },
      undefined,
      undefined,
      harness.ctx,
    ),
    /needs Pi TUI or RPC UI support/,
  );
});

nodeTest(
  "ask_question uses sequential RPC dialogs and supports custom and multi-select answers",
  async () => {
    const harness = fakeHarness();
    const tool = askTool(harness);
    harness.setMode("rpc");
    harness.selections.push("Type a custom answer", "☐ A", "☐ B", "Done selecting");
    harness.inputs.push("custom value");

    const result = await tool.execute(
      "call_1",
      {
        questions: [
          { id: "one", question: "First?" },
          { id: "many", question: "Second?", options: ["A", "B"], multiSelect: true },
        ],
      },
      undefined,
      undefined,
      harness.ctx,
    );

    assert.deepEqual(
      harness.dialogCalls.map((call) => `${call.method}:${call.title}`),
      ["select:First?", "input:First?", "select:Second?", "select:Second?", "select:Second?"],
    );
    assert.deepEqual(
      result.details.answers.map((answer) => answer.answer),
      ["custom value", "A, B"],
    );
    assert.equal(result.details.cancelled, false);
  },
);

nodeTest("RPC multi-select lets a user undo a choice before submitting", async () => {
  const harness = fakeHarness();
  harness.setMode("rpc");
  harness.selections.push("☐ A", "☑ A", "☐ B", "Done selecting");

  const result = await askTool(harness).execute(
    "correct-choice",
    { question: "Which?", options: ["A", "B"], multiSelect: true },
    undefined,
    undefined,
    harness.ctx,
  );

  assert.deepEqual(
    harness.dialogCalls.map((call) => call.options),
    [
      ["☐ A", "☐ B", "Type a custom answer"],
      ["☑ A", "☐ B", "Type a custom answer", "Done selecting"],
      ["☐ A", "☐ B", "Type a custom answer"],
      ["☐ A", "☑ B", "Type a custom answer", "Done selecting"],
    ],
  );
  assert.ok(harness.dialogCalls.every((call) => call.title === "Which?"));
  assert.deepEqual(result.details.answers[0]?.selectedOptions, ["B"]);
  assert.equal(contentText(result), 'User answered: ["B"]');
});

nodeTest("RPC multi-select can remove a custom answer that matches a control label", async () => {
  const harness = fakeHarness();
  harness.setMode("rpc");
  harness.selections.push("Type a custom answer", "☑ Done selecting", "☐ A", "Done selecting");
  harness.inputs.push("Done selecting");

  const result = await askTool(harness).execute(
    "correct-custom",
    { question: "Which?", options: ["A"], multiSelect: true },
    undefined,
    undefined,
    harness.ctx,
  );

  assert.deepEqual(
    harness.dialogCalls.filter((call) => call.method === "select").map((call) => call.options),
    [
      ["☐ A", "Type a custom answer"],
      ["☐ A", "☑ Done selecting", "Type a custom answer", "Done selecting"],
      ["☐ A", "Type a custom answer"],
      ["☑ A", "Type a custom answer", "Done selecting"],
    ],
  );
  assert.deepEqual(result.details.answers[0]?.selectedOptions, ["A"]);
  assert.equal(contentText(result), 'User answered: ["A"]');
});

nodeTest(
  "ask_question preserves comma-containing multi-select choices in TUI and RPC results",
  async () => {
    const options = ["A", "B, C", "A, B", "C"];
    const params = { question: "Which parts?", options, multiSelect: true };

    async function choose(mode: "tui" | "rpc", indices: number[]) {
      const harness = fakeHarness();
      harness.setMode(mode);
      const selectedOptions = indices.map((index) => options[index]);
      if (mode === "rpc") {
        harness.selections.push(
          ...selectedOptions.map((option) => `☐ ${option ?? ""}`),
          "Done selecting",
        );
      }
      const controller = new AbortController();
      const execution = askTool(harness).execute(
        "commas",
        params,
        controller.signal,
        undefined,
        harness.ctx,
      );
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
      assert.deepEqual(first.details.answers[0]?.selectedOptions, ["A", "B, C"]);
      assert.deepEqual(second.details.answers[0]?.selectedOptions, ["A, B", "C"]);
      assert.equal(contentText(first), 'User answered: ["A","B, C"]');
      assert.equal(contentText(second), 'User answered: ["A, B","C"]');
    }
  },
);

nodeTest("TUI review preserves spaces inside wrapped multi-select choices", async () => {
  for (const choice of ["B, C", "B,C"]) {
    const harness = fakeHarness();
    const controller = new AbortController();
    const execution = askTool(harness).execute(
      "review",
      { question: "Which parts?", options: ["A", "B, C", "B,C"], multiSelect: true },
      controller.signal,
      undefined,
      harness.ctx,
    );
    const component = harness.getCustomComponent();
    component.handleInput(" ");
    component.handleInput("\u001b[B");
    if (choice === "B,C") {
      component.handleInput("\u001b[B");
    }
    component.handleInput(" ");
    component.handleInput("\r");

    try {
      const prefix = "question_1: ";
      const lines = component.render(20);
      const start = lines.findIndex((line: string) => line.startsWith(prefix));
      assert.ok(start >= 0);
      assert.equal(
        lines
          .slice(start, start + 2)
          .map((line: string) => line.slice(prefix.length))
          .join(""),
        JSON.stringify(["A", choice]),
      );
    } finally {
      controller.abort();
      await execution;
    }
  }
});

nodeTest(
  "TUI review keeps wide choices visible when the answer indent leaves one column",
  async () => {
    for (const [id, width] of [
      ["question_1", 13],
      ["abcdefghijklmnopq", 20],
    ] as const) {
      const harness = fakeHarness();
      const controller = new AbortController();
      const execution = askTool(harness).execute(
        "wide-review",
        { questions: [{ id, question: "Which?", options: ["漢"], multiSelect: true }] },
        controller.signal,
        undefined,
        harness.ctx,
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
  },
);

nodeTest("TUI tool result distinguishes choices whose spaces fall on a wrap", async () => {
  const withSpace = "XXXXXXXXXXXXX, C";
  const withoutSpace = "XXXXXXXXXXXXX,C";

  async function rendered(choice: string) {
    const harness = fakeHarness();
    harness.setMode("rpc");
    harness.selections.push("☐ A", `☐ ${choice}`, "Done selecting");
    const tool = askTool(harness);
    const result = await tool.execute(
      "result",
      { question: "Which?", options: ["A", withSpace, withoutSpace], multiSelect: true },
      undefined,
      undefined,
      harness.ctx,
    );
    return tool
      .renderResult(result, { expanded: false, isPartial: false }, harness.theme, harness.ctx)
      .render(20);
  }

  assert.notDeepEqual(await rendered(withSpace), await rendered(withoutSpace));
});

nodeTest("ask_question retries RPC option selection after blank custom input", async () => {
  const harness = fakeHarness();
  const tool = askTool(harness);
  harness.setMode("rpc");
  harness.selections.push("Type a custom answer", "A");
  harness.inputs.push("   ");

  const result = await tool.execute(
    "call_1",
    { question: "Continue?", options: ["A"] },
    undefined,
    undefined,
    harness.ctx,
  );

  assert.deepEqual(
    harness.dialogCalls.map((call) => call.method),
    ["select", "input", "select"],
  );
  assert.equal(result.details.answers[0]?.answer, "A");
  assert.equal(result.details.cancelled, false);
});

nodeTest("ask_question reports RPC cancellation and forwards the abort signal", async () => {
  const harness = fakeHarness();
  const tool = askTool(harness);
  harness.setMode("rpc");
  harness.selections.push(undefined);
  const controller = new AbortController();

  const result = await tool.execute(
    "call_1",
    { question: "Continue?" },
    controller.signal,
    undefined,
    harness.ctx,
  );

  controller.abort();
  assert.equal(harness.dialogCalls[0]?.signal?.aborted, true);
  assert.equal(result.details.cancelled, true);
  assert.equal(result.details.timedOut, false);
  assert.match(contentText(result), /cancelled/);
});

nodeTest("ask_question returns TUI cancellation when already aborted", async () => {
  const harness = fakeHarness();
  const controller = new AbortController();
  controller.abort();

  const result = await askTool(harness).execute(
    "call_1",
    { question: "Continue?" },
    controller.signal,
    undefined,
    harness.ctx,
  );

  assert.equal(result.details.cancelled, true);
});

nodeTest(
  "ask_question reflows after terminal resize and forwards focus to its editor",
  async () => {
    const harness = fakeHarness();
    const execution = askTool(harness).execute(
      "call_1",
      {
        questions: [
          {
            id: "this_identifier_is_far_too_long",
            question:
              "漢🙂 A deliberately long question that must wrap when the terminal becomes narrow?",
          },
          { id: "second", question: "Second question?" },
        ],
      },
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
    for (const width of narrowWidths) {
      assertFits(width);
    }

    component.handleInput("\u001b[C");
    component.handleInput("\u001b[C");
    for (const width of narrowWidths) {
      assertFits(width);
    }

    component.handleInput("\u001b[C");
    component.focused = true;
    component.handleInput("\r");
    component.handleInput("漢🙂");
    for (const width of narrowWidths) {
      assertFits(width);
    }
    assert.ok(component.render(1).some((line: string) => line.includes(CURSOR_MARKER)));
    assert.ok(component.render(20).some((line: string) => line.includes(CURSOR_MARKER)));
    component.focused = false;
    assert.ok(component.render(20).every((line: string) => !line.includes(CURSOR_MARKER)));
    component.focused = true;
    assert.ok(component.render(20).some((line: string) => line.includes(CURSOR_MARKER)));
    component.handleInput("\u001b");
    component.handleInput("\u001b");
    await execution;
  },
);

nodeTest("ask_question keeps wide options and answered review within narrow widths", async () => {
  const harness = fakeHarness();
  const execution = askTool(harness).execute(
    "call_1",
    {
      questions: [
        { question: "First?", options: ["漢🙂 option"] },
        { question: "Second?", options: ["Yes"] },
      ],
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const component = harness.getCustomComponent();
  const assertFits = (width: number) => {
    assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
  };

  for (const width of [3, 2, 1]) {
    assertFits(width);
  }
  component.handleInput("\r");
  component.handleInput("\r");
  for (const width of [3, 2, 1]) {
    assertFits(width);
  }
  component.handleInput("\u001b");
  await execution;
});

nodeTest(
  "ask_question keeps the question and selected wrapped option visible on short and resized terminals",
  async () => {
    const harness = fakeHarness();
    const options = Array.from({ length: 30 }, (_, index) => `Choice ${index + 1}`);
    options[15] =
      "A detailed choice with enough explanation to wrap across multiple rows while keeping its final words visible: tail marker";
    const controller = new AbortController();
    const execution = askTool(harness).execute(
      "long-list",
      { question: "Which choice should I use?", options },
      controller.signal,
      undefined,
      harness.ctx,
    );
    const component = harness.getCustomComponent();
    const visible = () => component.render(80).slice(-harness.terminal.rows);
    const assertSelection = (label: string) => {
      const rendered = component.render(80);
      assert.ok(
        rendered.length <= harness.terminal.rows,
        `Question UI uses ${rendered.length} of ${harness.terminal.rows} available rows`,
      );
      const screen = visible().join("\n");
      assert.match(screen, /Which choice should I use\?/);
      assert.ok(screen.includes(label), `${label} must remain in the native viewport`);
    };

    try {
      assertSelection("> 1. Choice 1");
      for (let index = 0; index < 16; index += 1) {
        component.handleInput("\u001b[B");
      }
      assertSelection("> 17. Choice 17");
      component.handleInput("\u001b[A");
      assertSelection("> 16. A detailed choice");
      assert.match(
        visible().join("\n"),
        /tail marker/,
        "The whole selected wrapped label remains readable",
      );

      harness.terminal.rows = 15;
      assertSelection("> 16. A detailed choice");
      assert.match(visible().join("\n"), /tail marker/);
      harness.terminal.rows = 24;
      assertSelection("> 16. A detailed choice");

      for (let index = 0; index < 14; index += 1) {
        component.handleInput("\u001b[B");
      }
      assertSelection("> 30. Choice 30");
      component.handleInput("\r");
      assert.equal((await execution).details.answers[0]?.answer, "Choice 30");
    } finally {
      controller.abort();
      await execution;
    }
  },
);

nodeTest(
  "ask_question previews only selected answers after deselecting a matching custom value",
  async () => {
    const harness = fakeHarness();
    const controller = new AbortController();
    const execution = askTool(harness).execute(
      "preview",
      { question: "Choose?", options: ["A", "B"], multiSelect: true },
      controller.signal,
      undefined,
      harness.ctx,
    );
    const component = harness.getCustomComponent();
    try {
      // Enter custom A, select B, then deselect the predefined A.
      for (const key of [
        "\u001b[B",
        "\u001b[B",
        "\r",
        "A",
        "\r",
        "\u001b[A",
        " ",
        "\u001b[A",
        " ",
      ]) {
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
  },
);

nodeTest("ask_question shows and honors configured editor bindings", async () => {
  const originalKeybindings = getKeybindings();
  setKeybindings(
    new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.input.submit": "ctrl+s",
      "tui.select.confirm": "ctrl+y",
      "tui.select.cancel": "ctrl+x",
    }),
  );

  try {
    const harness = fakeHarness();
    const execution = askTool(harness).execute(
      "call_1",
      { question: "Choose?", options: ["First", "Second"] },
      undefined,
      undefined,
      harness.ctx,
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
    assert.equal(result.details.answers[0]?.answer, "Custom");

    const cancelledHarness = fakeHarness();
    const cancelledExecution = askTool(cancelledHarness).execute(
      "call_2",
      { question: "Cancel?" },
      undefined,
      undefined,
      cancelledHarness.ctx,
    );
    cancelledHarness.getCustomComponent().handleInput("\u0018");
    assert.equal((await cancelledExecution).details.cancelled, true);
  } finally {
    setKeybindings(originalKeybindings);
  }
});

nodeTest("ask_question closes active TUI on abort and removes its listener", async () => {
  const harness = fakeHarness();
  const controller = new AbortController();

  const execution = askTool(harness).execute(
    "call_1",
    { question: "Continue?" },
    controller.signal,
    undefined,
    harness.ctx,
  );
  controller.abort();
  const result = await execution;

  assert.equal(result.details.cancelled, true);
  assert.equal(harness.getCustomDoneCalls(), 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  harness.getCustomComponent().dispose();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

function pendingDialog(
  _title: string,
  _options?: string[] | string,
  opts?: { signal?: AbortSignal },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const settle = (answer?: string): void => {
      resolve(answer);
    };
    if (opts?.signal?.aborted === true) {
      settle();
    } else {
      opts?.signal?.addEventListener("abort", () => settle(), { once: true });
    }
  });
}

nodeTest(
  "ask_question returns the AFK reply at exactly five minutes without choosing an option",
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const harness = fakeHarness();
    const controller = new AbortController();
    const tool = askTool(harness);
    const execution = tool.execute(
      "timeout",
      { question: "Choose?", options: ["First", "Second"] },
      controller.signal,
      undefined,
      harness.ctx,
    );
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
    assert.equal(
      contentText(result),
      "Timed out after 5 minutes. Mitch is currently AFK. Use your best judgement to choose the option Mitch would choose.",
    );
    const rendered = tool
      .renderResult(result, { expanded: false, isPartial: false }, harness.theme, harness.ctx)
      .render(80)
      .join("\n");
    assert.match(rendered, /Timed out after 5 minutes/);
    assert.match(rendered, /AFK/);
    assert.doesNotMatch(rendered, /Cancelled|✓|User answered/);
    controller.abort();
    t.mock.timers.tick(300_000);
    assert.equal(harness.getCustomDoneCalls(), 1);
  },
);

nodeTest(
  "interaction keeps a question set open beyond five minutes without affecting the next call",
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const harness = fakeHarness();
    const controller = new AbortController();
    const execution = askTool(harness).execute(
      "partial",
      {
        questions: [
          { question: "First?", options: ["A"] },
          { question: "Second?", options: ["B"], multiSelect: true },
        ],
      },
      controller.signal,
      undefined,
      harness.ctx,
    );
    const component = harness.getCustomComponent();
    try {
      t.mock.timers.tick(200_000);
      component.handleInput("\r");
      component.handleInput(" ");
      component.handleInput("\u001b[B");
      component.handleInput("\r");
      component.handleInput("A lengthy draft");
      t.mock.timers.tick(400_000);
      assert.equal(
        harness.getCustomDoneCalls(),
        0,
        "Typing and earlier choices must prevent an AFK result",
      );
      component.handleInput("\r");
      component.handleInput("\u001b[C");
      component.handleInput("\r");
      const result = await execution;
      assert.equal(result.details.timedOut, false);
      assert.deepEqual(
        result.details.answers.map((answer) => answer.answer),
        ["A", "B, A lengthy draft"],
      );
      assert.deepEqual(result.details.answers[1]?.selectedOptions, ["B", "A lengthy draft"]);
    } finally {
      controller.abort();
      await execution;
    }

    const next = askTool(harness).execute(
      "next",
      { question: "Another question?" },
      undefined,
      undefined,
      harness.ctx,
    );
    t.mock.timers.tick(300_000);
    assert.equal((await next).details.timedOut, true, "A new untouched question still times out");
  },
);

nodeTest("a mouse interaction keeps the question open", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const type of ["press", "move"] as const) {
    const harness = fakeHarness();
    const controller = new AbortController();
    const execution = askTool(harness).execute(
      "mouse",
      { question: "Choose?", options: ["A"] },
      controller.signal,
      undefined,
      harness.ctx,
    );
    const component = harness.getCustomComponent();
    try {
      component.handleMouse(mouseEvent(type, 2, 2));
      t.mock.timers.tick(300_000);
      assert.equal(harness.getCustomDoneCalls(), 0);
      assert.match(component.render(80).join("\n"), /No time limit while you answer/);
      component.handleInput("\r");
      assert.equal((await execution).details.answers[0]?.answer, "A");
    } finally {
      controller.abort();
      await execution;
    }
  }
});

nodeTest("RPC choices keep later dialogs open past the original timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = fakeHarness();
  harness.setMode("rpc");
  harness.selections.push("Type a custom answer", "☐ B");
  harness.inputs.push("Typed answer");
  const select = harness.ctx.ui.select;
  const input = harness.ctx.ui.input;
  let pendingSignal: AbortSignal | undefined;
  harness.ctx.ui.select = async (...args) => {
    if (harness.selections.length === 0) {
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
  const controller = new AbortController();
  const execution = askTool(harness).execute(
    "rpc-partial",
    {
      questions: [
        { question: "First?" },
        { question: "Second?", options: ["B", "C"], multiSelect: true },
      ],
    },
    controller.signal,
    undefined,
    harness.ctx,
  );
  try {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.ok(pendingSignal);
    t.mock.timers.tick(130_000);
    assert.equal(pendingSignal.aborted, false);
  } finally {
    controller.abort();
    const result = await execution;
    assert.equal(result.details.cancelled, true);
    assert.deepEqual(
      result.details.answers.map((answer) => answer.answer),
      ["Typed answer", "B"],
    );
    assert.ok(pendingSignal !== undefined);
    assert.equal(getEventListeners(pendingSignal, "abort").length, 0);
  }
});

nodeTest(
  "RPC custom answer selection disables timeout and caller cancellation still works",
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const harness = fakeHarness();
    harness.setMode("rpc");
    harness.selections.push("Type a custom answer");
    let pendingSignal: AbortSignal | undefined;
    harness.ctx.ui.input = async (...args) => {
      pendingSignal = args[2]?.signal;
      return pendingDialog(...args);
    };
    const controller = new AbortController();
    const execution = askTool(harness).execute(
      "rpc-input",
      { question: "Details?" },
      controller.signal,
      undefined,
      harness.ctx,
    );
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      t.mock.timers.tick(300_000);
      assert.equal(pendingSignal?.aborted, false, "An open custom answer must not time out");
    } finally {
      controller.abort();
      const result = await execution;
      assert.equal(result.details.cancelled, true);
    }
  },
);

nodeTest("ask_question clears its timer after an answer, cancellation, or UI error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const key of ["\r", "\u001b"]) {
    const harness = fakeHarness();
    const execution = askTool(harness).execute(
      "early",
      { question: "Choose?", options: ["A"] },
      undefined,
      undefined,
      harness.ctx,
    );
    harness.getCustomComponent().handleInput(key);
    const result = await execution;
    assert.equal(result.details.timedOut, false);
    assert.equal(result.details.cancelled, key === "\u001b");
    t.mock.timers.tick(300_000);
    assert.equal(harness.getCustomDoneCalls(), 1);
  }
  const harness = fakeHarness();
  harness.ctx.ui.custom = async () => {
    throw new Error("UI failed");
  };
  await assert.rejects(
    askTool(harness).execute("error", { question: "Choose?" }, undefined, undefined, harness.ctx),
    /UI failed/,
  );
});

function remoteHarness() {
  const harness = fakeHarness();
  const states: Array<Record<string, unknown>> = [];
  const receipts: Array<{ requestId: string; promptId: string; status: string }> = [];
  harness.events.on("pi-ask-question:state", (state: Record<string, unknown>) =>
    states.push(state),
  );
  harness.events.on(
    "pi-ask-question:result",
    (receipt: { requestId: string; promptId: string; status: string }) => receipts.push(receipt),
  );
  const start = (params: unknown, signal?: AbortSignal) =>
    askTool(harness).execute(
      "remote",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-004: bus fuzz payloads are deliberately invalid; runtime schema validation in normalize is the guard, proven by the schema rejection test.
      params as Static<typeof AskQuestionParams>,
      signal,
      undefined,
      harness.ctx,
    );
  const reply = (target: Record<string, unknown>, answer: unknown, requestId = "reply") => {
    harness.events.emit("pi-ask-question:answer", {
      requestId,
      promptId: target.promptId,
      questionId: target.questionId,
      revision: target.revision,
      answer,
    });
  };
  return { ...harness, states, receipts, start, reply };
}

type RemoteHarness = ReturnType<typeof remoteHarness>;

/** The last element of a recorded array, asserted present. */
function lastOf<T>(values: T[]): T {
  const value = values.at(-1);
  assert.ok(value !== undefined);
  return value;
}

/** A lookup-result event as the tests read it. */
type LookupResult = {
  status: string;
  questionId?: string;
  answerFingerprint?: string;
};

/** The bus state at an index, asserted present; field reads stay untyped wire data. */
function busState(harness: RemoteHarness, index = -1): Record<string, unknown> {
  const state = harness.states.at(index);
  assert.ok(state !== undefined);
  return state;
}

/** A numeric bus-state field, asserted to be a number. */
function stateNumber(state: Record<string, unknown>, key: string): number {
  const value = state[key];
  assert.ok(typeof value === "number");
  return value;
}

nodeTest(
  "navigation keeps the cooperative question answerable after its original deadline",
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
    const harness = remoteHarness();
    const controller = new AbortController();
    const snapshots: Array<Record<string, unknown>> = [];
    harness.events.on("pi-ask-question:snapshot", (value: Record<string, unknown>) =>
      snapshots.push(value),
    );
    const execution = harness.start(
      { question: "Choose?", options: ["A", "B"] },
      controller.signal,
    );
    try {
      const initial = busState(harness);
      assert.equal(initial.timeoutActive, true);
      harness.getCustomComponent().handleInput("\u001b[B");
      t.mock.timers.tick(300_000);
      harness.events.emit("pi-ask-question:query", {
        queryId: "after-interaction",
        protocolVersion: 1,
      });
      const waiting = lastOf(snapshots);
      assert.equal(waiting.status, "waiting");
      assert.equal(waiting.timeoutActive, false);
      assert.equal(waiting.deadline, initial.deadline);
      harness.events.emit("pi-ask-question:answer", {
        ...waiting,
        requestId: "late-answer",
        answer: "B",
      });
      assert.equal(harness.receipts.at(-1)?.status, "answered");
      assert.equal((await execution).details.answers[0]?.answer, "B");
    } finally {
      controller.abort();
      await execution;
    }
  },
);

const flushState = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

nodeTest(
  "an untouched expired target rejects a remote answer before the timeout callback runs",
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
    const harness = remoteHarness();
    const execution = harness.start({ question: "Choose?" });
    const target = busState(harness);
    t.mock.timers.setTime(stateNumber(target, "deadline"));
    harness.reply(target, "too late");
    assert.equal(harness.receipts.at(-1)?.status, "stale");
    t.mock.timers.tick(300_000);
    assert.equal((await execution).details.timedOut, true);
  },
);

nodeTest(
  "a late observer reads the true current target and looks up a lost accepted result without replay",
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
    const harness = remoteHarness();
    const execution = harness.start({
      questions: [{ question: "First?" }, { question: "Second?" }],
    });
    const snapshots: Array<Record<string, unknown>> = [];
    const lookups: LookupResult[] = [];
    harness.events.on("pi-ask-question:snapshot", (data: Record<string, unknown>) =>
      snapshots.push(data),
    );
    harness.events.on("pi-ask-question:lookup-result", (data: LookupResult) => lookups.push(data));
    const query = () =>
      harness.events.emit("pi-ask-question:query", { queryId: "late", protocolVersion: 1 });
    t.mock.timers.tick(200_000);
    query();
    const target = lastOf(snapshots);
    assert.equal(
      target.status,
      "waiting",
      "An observer attaching after waiting was emitted receives a snapshot",
    );
    assert.equal(target.deadline, 301_000);
    assert.equal(target.nativeRoot, "native-test-root");
    assert.equal(typeof target.ownerGeneration, "string");
    for (const changed of [
      { ownerGeneration: "old-owner" },
      { nativeRoot: "other-root" },
      { deadline: target.deadline + 1 },
      { protocolVersion: 2 },
    ]) {
      harness.events.emit("pi-ask-question:answer", {
        ...target,
        ...changed,
        requestId: "not-applied",
        answer: "wrong target",
      });
      assert.equal(harness.receipts.at(-1)?.status, "stale");
    }
    harness.events.emit("pi-ask-question:answer", {
      ...target,
      requestId: "accepted-first",
      answer: "saved",
    });
    // Discard the result, as a disconnected adapter would.
    harness.receipts.length = 0;
    query();
    assert.equal(
      lastOf(snapshots).questionId,
      "question_2",
      "Query reads fresh owner state before coalesced publication",
    );
    assert.equal(
      lastOf(snapshots).deadline,
      target.deadline,
      "Progression never extends the timer",
    );
    const lookup = {
      protocolVersion: 1,
      queryId: "reconcile",
      ownerGeneration: target.ownerGeneration,
      nativeRoot: target.nativeRoot,
      promptId: target.promptId,
      requestId: "accepted-first",
    };
    harness.events.emit("pi-ask-question:lookup", lookup);
    assert.equal(lastOf(lookups).status, "answered");
    assert.equal(lastOf(lookups).questionId, target.questionId);
    const fingerprint = lastOf(lookups).answerFingerprint;
    assert.ok(typeof fingerprint === "string");
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    harness.events.emit("pi-ask-question:answer", {
      ...lastOf(snapshots),
      requestId: "accepted-first",
      answer: "changed",
    });
    assert.equal(harness.receipts.at(-1)?.status, "stale");
    harness.reply(lastOf(snapshots), "last", "accepted-last");
    assert.deepEqual(
      (await execution).details.answers.map((answer) => answer.answer),
      ["saved", "last"],
    );
    harness.events.emit("pi-ask-question:lookup", lookup);
    assert.equal(
      lastOf(lookups).status,
      "answered",
      "Completion retains the accepted application, not just a live listener",
    );
    harness.events.emit("pi-ask-question:lookup", { ...lookup, requestId: "never-applied" });
    assert.equal(
      lastOf(lookups).status,
      "unknown",
      "Absence is not proof an answer was not applied elsewhere",
    );
    harness.events.emit("pi-ask-question:lookup", { ...lookup, ownerGeneration: "old-owner" });
    assert.equal(lastOf(lookups).status, "stale");
    harness.events.emit("pi-ask-question:query", { queryId: "future", protocolVersion: 2 });
    assert.equal(lastOf(snapshots).status, "unsupported");
  },
);

nodeTest(
  "the observer reports RPC and print as unsupported without injecting UI input",
  async () => {
    for (const mode of ["rpc", "print"]) {
      const harness = fakeHarness();
      harness.setMode(mode);
      await eventHandler(harness, "session_start")({}, harness.ctx);
      let snapshot: Record<string, unknown> | undefined;
      harness.events.on("pi-ask-question:snapshot", (data: Record<string, unknown>) => {
        snapshot = data;
      });
      harness.events.emit("pi-ask-question:query", { protocolVersion: 1, queryId: "mode" });
      assert.ok(snapshot !== undefined);
      assert.equal(snapshot.status, "unsupported");
      assert.equal(snapshot.mode, mode);
      assert.equal(harness.dialogCalls.length, 0);
      assert.equal(harness.getCustomDoneCalls(), 0);
    }
  },
);

nodeTest(
  "remote strings complete the actual TUI owner as literal custom answers, never option matches",
  async () => {
    for (const text of ["Yes", "yes please", "/grill-me on", "  界🙂, keep this\nliteral  "]) {
      const harness = remoteHarness();
      harness.events.on("pi-ask-question:result", () => {
        assert.equal(
          harness.getCustomDoneCalls(),
          1,
          "Success is emitted after the owner's completion callback",
        );
      });
      const execution = harness.start({ question: "Approve?", options: ["Yes", "No"] });
      const target = busState(harness, 0);
      assert.equal(target.status, "waiting");
      assert.deepEqual(target.options, ["Yes", "No"]);
      harness.reply(target, text);
      assert.equal(harness.getCustomDoneCalls(), 1);
      assert.deepEqual(harness.receipts, [
        { requestId: "reply", promptId: target.promptId, status: "answered" },
      ]);
      assert.deepEqual((await execution).details.answers, [
        {
          id: "question_1",
          question: "Approve?",
          answer: text.trim(),
          wasCustom: true,
        },
      ]);
      harness.reply(target, "No");
      harness.getCustomComponent().handleInput("\r");
      harness.getCustomComponent().dispose();
      await flushState();
      assert.equal(harness.getCustomDoneCalls(), 1);
      assert.equal(harness.events.listenerCount("pi-ask-question:answer"), 0);
      assert.deepEqual(
        harness.states.map((state) => state.status),
        ["waiting", "closed"],
      );
    }
  },
);

nodeTest(
  "remote answers validate payloads without splitting or fuzzy matching and preserve exact multi-select progression",
  async () => {
    const harness = remoteHarness();
    const execution = harness.start({
      questions: [
        { id: "parts", question: "First?", options: ["Yes"] },
        { id: "parts", question: "Which parts?", options: ["A", "B, C"], multiSelect: true },
        { id: "why", question: "Why?", multiSelect: true },
      ],
    });
    let target = busState(harness);
    for (const answer of ["", "   ", "x".repeat(16_385), ["Yes"], null, { text: "Yes" }]) {
      harness.reply(target, answer, "invalid");
      assert.equal(harness.receipts.at(-1)?.status, "invalid");
      assert.equal(harness.getCustomDoneCalls(), 0);
    }
    harness.reply(target, "Yes", "first");
    await flushState();
    const firstTarget = target;
    target = busState(harness);
    assert.equal(target.questionId, "parts_2");
    assert.ok(stateNumber(target, "revision") > stateNumber(firstTarget, "revision"));
    harness.reply(firstTarget, "overwrite", "old-question");
    assert.equal(harness.receipts.at(-1)?.status, "stale");
    harness.reply(target, ["A"], "first");
    assert.equal(
      harness.receipts.at(-1)?.status,
      "stale",
      "Accepted request IDs cannot be reused for a new question",
    );
    const sparse: unknown[] = [];
    sparse.length = 1;
    for (const answer of [[], ["B"], ["a"], ["A", "A"], ["A,B, C"], ["A", 1], sparse]) {
      harness.reply(target, answer, "invalid");
      assert.equal(harness.receipts.at(-1)?.status, "invalid");
    }
    harness.reply(target, ["B, C", "A"], "second");
    await flushState();
    target = busState(harness);
    assert.equal(target.questionId, "why");
    harness.reply(target, "because, literally", "third");
    const result = await execution;
    assert.deepEqual(result.details.answers, [
      { id: "parts", question: "First?", answer: "Yes", wasCustom: true },
      {
        id: "parts_2",
        question: "Which parts?",
        answer: "B, C, A",
        selectedOptions: ["B, C", "A"],
        wasCustom: false,
      },
      {
        id: "why",
        question: "Why?",
        answer: "because, literally",
        selectedOptions: ["because, literally"],
        wasCustom: true,
      },
    ]);
    assert.equal(result.details.cancelled, false);
    assert.equal(harness.getCustomDoneCalls(), 1);
  },
);

nodeTest(
  "local commits and tab changes invalidate frozen remote revisions without losing local selections",
  async () => {
    const harness = remoteHarness();
    const execution = harness.start({
      questions: [
        { id: "parts", question: "Parts?", options: ["A", "B"], multiSelect: true },
        { id: "next", question: "Next?", options: ["Continue"] },
      ],
    });
    const component = harness.getCustomComponent();
    const initial = busState(harness);
    component.handleInput(" ");
    harness.reply(initial, ["B"]);
    assert.equal(
      harness.receipts.at(-1)?.status,
      "stale",
      "Local selection wins even before state publication",
    );
    await flushState();
    const selected = busState(harness);
    component.handleInput("\u001b[C");
    component.handleInput("\u001b[D");
    harness.reply(selected, ["B"], "returned-to-same-question");
    assert.equal(harness.receipts.at(-1)?.status, "stale");
    component.handleInput("\r");
    component.handleInput("\r");
    assert.match(component.render(80).join("\n"), /parts: \["A"\]/);
    component.handleInput("\r");
    assert.deepEqual(
      (await execution).details.answers.map((answer) => answer.answer),
      ["A", "Continue"],
    );
  },
);

nodeTest(
  "local single-answer race and expired prompt IDs cannot retarget a subsequent tool call",
  async () => {
    const harness = remoteHarness();
    const execution = harness.start({ question: "Local first?", options: ["Keep local"] });
    const old = busState(harness);
    harness.getCustomComponent().handleInput("\r");
    harness.reply(old, "replace local");
    assert.equal((await execution).details.answers[0]?.answer, "Keep local");
    assert.equal(harness.receipts.length, 0, "A disposed owner does not acknowledge late delivery");
    const next = harness.start({ question: "New owner?", options: ["Next"] });
    const current = busState(harness);
    assert.notEqual(current.promptId, old.promptId);
    harness.reply(old, "wrong prompt");
    assert.equal(harness.getCustomDoneCalls(), 1);
    harness.reply({ ...current, questionId: "wrong" }, "wrong question");
    harness.reply({ ...current, revision: stateNumber(current, "revision") + 1 }, "wrong revision");
    assert.deepEqual(
      harness.receipts.map((receipt) => receipt.status),
      ["stale", "stale"],
    );
    harness.reply(current, "new owner");
    assert.equal((await next).details.answers[0]?.answer, "new owner");
  },
);

nodeTest(
  "local custom editing withdraws the remote target and preserves its draft and cancel behavior",
  async () => {
    const harness = remoteHarness();
    const execution = harness.start({ question: "Details?" });
    const target = busState(harness);
    const component = harness.getCustomComponent();
    component.handleInput("\r");
    component.handleInput("local draft");
    let snapshot: Record<string, unknown> | undefined;
    harness.events.on("pi-ask-question:snapshot", (data: Record<string, unknown>) => {
      snapshot = data;
    });
    harness.events.emit("pi-ask-question:query", { queryId: "editing", protocolVersion: 1 });
    assert.ok(snapshot !== undefined);
    assert.equal(
      snapshot.status,
      "idle",
      "Late observers cannot acquire a target while local editing owns it",
    );
    harness.reply(target, "remote draft");
    assert.equal(harness.receipts.at(-1)?.status, "stale");
    await flushState();
    assert.equal(busState(harness).status, "closed");
    component.handleInput("\u001b");
    await flushState();
    const resumed = busState(harness);
    assert.equal(resumed.status, "waiting");
    assert.ok(stateNumber(resumed, "revision") > stateNumber(target, "revision"));
    component.handleInput("\r");
    component.handleInput("local final");
    component.handleInput("\r");
    assert.equal((await execution).details.answers[0]?.answer, "local final");
  },
);

nodeTest(
  "an accepted remote answer disables timeout for the rest of the question set",
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
    const harness = remoteHarness();
    const controller = new AbortController();
    const execution = harness.start(
      { questions: [{ question: "First?" }, { question: "Second?" }] },
      controller.signal,
    );
    try {
      t.mock.timers.tick(200_000);
      harness.reply(busState(harness), "saved");
      await flushState();
      const target = busState(harness);
      assert.equal(target.deadline, 301_000);
      assert.equal(target.timeoutActive, false);
      t.mock.timers.tick(100_000);
      assert.equal(harness.getCustomDoneCalls(), 0);
      harness.reply(target, "second answer", "after-deadline");
      assert.equal(harness.receipts.at(-1)?.status, "answered");
      const result = await execution;
      assert.equal(result.details.timedOut, false);
      assert.deepEqual(
        result.details.answers.map((answer) => answer.answer),
        ["saved", "second answer"],
      );
      assert.equal(harness.events.listenerCount("pi-ask-question:answer"), 0);
    } finally {
      controller.abort();
      await execution;
    }
  },
);

nodeTest(
  "abort, component disposal and shutdown/reload dispose live answer subscriptions idempotently",
  async () => {
    for (const close of ["abort", "shutdown", "dispose"] as const) {
      const harness = remoteHarness();
      const controller = new AbortController();
      const execution = harness.start({ question: "Still live?" }, controller.signal);
      const target = busState(harness);
      if (close === "abort") {
        controller.abort();
      } else if (close === "dispose") {
        harness.getCustomComponent().dispose();
      } else {
        eventHandler(harness, "session_shutdown")(
          { type: "session_shutdown", reason: "reload" },
          harness.ctx,
        );
      }
      harness.reply(target, "late");
      harness.getCustomComponent().dispose();
      controller.abort();
      assert.equal((await execution).details.cancelled, true);
      assert.equal(harness.getCustomDoneCalls(), 1);
      assert.equal(harness.events.listenerCount("pi-ask-question:answer"), 0);
      if (close === "shutdown") {
        assert.equal(harness.events.listenerCount("pi-ask-question:query"), 0);
        assert.equal(harness.events.listenerCount("pi-ask-question:lookup"), 0);
      }
      assert.deepEqual(
        harness.states.map((state) => state.status),
        ["waiting", "closed"],
      );
      assert.deepEqual(harness.receipts, []);
    }
  },
);

nodeTest(
  "ask_question renderCall shows count and ids, renderResult shows answers or cancelled",
  () => {
    const harness = fakeHarness();
    const tool = askTool(harness);

    const call = tool.renderCall(
      {
        questions: [
          { id: "scope", question: "Scope?", options: ["a"] },
          { id: "checks", question: "Checks?", options: ["x", "y"], multiSelect: true },
        ],
      },
      harness.theme,
      harness.ctx,
    );
    const callOut = call.render(80).join("\n");
    assert.match(callOut, /ask_question/);
    assert.match(callOut, /2 questions/);
    assert.match(callOut, /scope, checks/);

    const cancelled = tool.renderResult(
      {
        content: [{ type: "text", text: "User cancelled the question." }],
        details: { questions: [], answers: [], cancelled: true, timedOut: false },
      },
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
          timedOut: false,
        },
      },
      { expanded: false, isPartial: false },
      harness.theme,
      harness.ctx,
    );
    const out = answered.render(80).join("\n");
    assert.match(out, /q/);
    assert.match(out, /Yes/);
  },
);

nodeTest(
  "ask_question returns distinct answer ids for duplicate and explicitly suffixed inputs",
  async () => {
    for (const ids of [
      ["x", "x", "x"],
      ["x", "x_2", "x"],
    ]) {
      const harness = fakeHarness();
      harness.setMode("rpc");
      harness.selections.push("Yes", "Yes", "Yes");
      const result = await askTool(harness).execute(
        "duplicate-ids",
        { questions: ids.map((id) => ({ id, question: "Continue?", options: ["Yes"] })) },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.deepEqual(
        result.details.answers.map((answer) => answer.id),
        ["x", "x_2", "x_3"],
      );
      assert.deepEqual(
        result.details.answers.map((answer) => answer.answer),
        ["Yes", "Yes", "Yes"],
      );
    }
  },
);

nodeTest("ask_question suffixes RPC controls past user option collisions", async () => {
  const harness = fakeHarness();
  harness.setMode("rpc");
  harness.selections.push(
    "☐ Type a custom answer",
    "☐ Type a custom answer (2)",
    "☐ Done selecting",
    "☐ Done selecting (2)",
    "Done selecting (3)",
  );

  const result = await askTool(harness).execute(
    "call_1",
    {
      question: "Pick?",
      options: [
        "Type a custom answer",
        "Type a custom answer (2)",
        "Done selecting",
        "Done selecting (2)",
      ],
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
    "☑ Type a custom answer",
    "☑ Type a custom answer (2)",
    "☑ Done selecting",
    "☑ Done selecting (2)",
    "Type a custom answer (3)",
    "Done selecting (3)",
  ]);
  assert.equal(
    result.details.answers[0]?.answer,
    "Type a custom answer, Type a custom answer (2), Done selecting, Done selecting (2)",
  );
});

nodeTest("grill-me completes on off status", () => {
  const harness = fakeHarness();
  const command = grillMeCommand(harness);
  const allCompletions = command.getArgumentCompletions("");
  assert.ok(allCompletions !== null);
  assert.deepEqual(allCompletions.map((i) => i.value).sort(), ["off", "on", "status"]);
  const oCompletions = command.getArgumentCompletions("o");
  assert.ok(oCompletions !== null);
  assert.deepEqual(oCompletions.map((i) => i.value).sort(), ["off", "on"]);
  assert.equal(command.getArgumentCompletions("zzz"), null);
});

nodeTest("grill-me toggles, persists, and updates footer status", async () => {
  const harness = fakeHarness();
  const command = grillMeCommand(harness);

  await command.handler("", harness.ctx);
  assert.deepEqual(harness.entries.at(-1), {
    type: "custom",
    customType: "ask-question.grill-me",
    data: { enabled: true },
  });
  assert.deepEqual(harness.statuses.at(-1), { key: "ask-question.grill-me", text: "grill-mode" });

  const event = promptEvent();
  assert.equal(await eventHandler(harness, "before_agent_start")(event, harness.ctx), undefined);
  const guidance = grillMeGuidance(event);
  assert.match(guidance, /call ask_question first/);
  assert.match(guidance, /Walk the decision tree/);
  assert.match(guidance, /reading local files, docs, tests, or command output/);
  assert.match(guidance, /Ask exactly one blocking question at a time/);
  assert.match(guidance, /recommended answer as the first option/);

  await command.handler("off", harness.ctx);
  assert.deepEqual(harness.entries.at(-1), {
    type: "custom",
    customType: "ask-question.grill-me",
    data: { enabled: false },
  });
  assert.deepEqual(harness.statuses.at(-1), { key: "ask-question.grill-me", text: undefined });
});

nodeTest("grill-me restores last valid branch state after reload", async () => {
  const harness = fakeHarness();
  harness.entries.push(
    { type: "custom", customType: "ask-question.grill-me", data: { enabled: false } },
    { type: "custom", customType: "ask-question.grill-me", data: { enabled: "yes" } },
    { type: "custom", customType: "ask-question.grill-me", data: { enabled: true } },
  );

  await eventHandler(harness, "session_start")({}, harness.ctx);
  assert.deepEqual(harness.statuses.at(-1), { key: "ask-question.grill-me", text: "grill-mode" });

  const event = promptEvent();
  await eventHandler(harness, "before_agent_start")(event, harness.ctx);
  assert.match(grillMeGuidance(event), /call ask_question first/);
});

nodeTest("grill-me skips footer status outside TUI", async () => {
  const harness = fakeHarness();
  await grillMeCommand(harness).handler("on", harness.ctx);
  harness.setMode("print");

  const statusesBefore = harness.statuses.length;
  await eventHandler(harness, "session_start")({}, harness.ctx);
  assert.equal(harness.statuses.length, statusesBefore);
});

nodeTest(
  "grill-me uses ask_question with RPC UI and text without UI or an active tool",
  async () => {
    const harness = fakeHarness();
    await grillMeCommand(harness).handler("on", harness.ctx);

    harness.setMode("rpc");
    let event = promptEvent();
    await eventHandler(harness, "before_agent_start")(event, harness.ctx);
    assert.match(grillMeGuidance(event), /call ask_question first/);

    harness.setMode("print");
    event = promptEvent();
    await eventHandler(harness, "before_agent_start")(event, harness.ctx);
    assert.doesNotMatch(grillMeGuidance(event), /call ask_question first/);
    assert.match(grillMeGuidance(event), /ask clarifying questions first in normal text/);

    harness.setMode("tui");
    harness.setActiveTools([]);
    event = promptEvent();
    await eventHandler(harness, "before_agent_start")(event, harness.ctx);
    assert.doesNotMatch(grillMeGuidance(event), /call ask_question first/);
    assert.match(grillMeGuidance(event), /ask clarifying questions first in normal text/);
  },
);

nodeTest("grill-me still appends to prior full overrides", async () => {
  const harness = fakeHarness();
  await grillMeCommand(harness).handler("on", harness.ctx);

  const result = await eventHandler(harness, "before_agent_start")(
    {
      systemPrompt: "base",
      systemPromptOptions: { sections: {}, forceSystemPrompt: "base" },
    },
    harness.ctx,
  );
  assert.ok(isSystemPromptResult(result));
  assert.match(result.systemPrompt, /base/);
  assert.match(result.systemPrompt, /call ask_question first/);
});

nodeTest("grill-me status and invalid args do not persist new state", async () => {
  const harness = fakeHarness();
  const command = grillMeCommand(harness);

  await command.handler("status", harness.ctx);
  assert.equal(harness.entries.length, 0);
  assert.deepEqual(harness.statuses.at(-1), { key: "ask-question.grill-me", text: undefined });

  await command.handler("enabled", harness.ctx);
  assert.equal(harness.entries.length, 0);
  assert.equal(harness.notifications.at(-1)?.type, "warning");
});
