import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";

// Use Pi's public Terminal injection, as its native TUI tests do. No process
// terminal, clipboard, renderer mock, or custom() double participates here.
class MemoryTerminal implements Terminal {
  columns = 80;
  rows = 40;
  kittyProtocolActive = false;
  output = "";
  onInput?: (data: string) => void;
  onResize?: () => void;
  start(onInput: (data: string) => void, onResize: () => void) {
    this.onInput = onInput;
    this.onResize = onResize;
  }
  stop() {
    this.onInput = undefined;
    this.onResize = undefined;
  }
  async drainInput() {}
  write(data: string) { this.output += data; }
  moveBy(_lines: number) {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(_title: string) {}
  setProgress(_active: boolean) {}
  send(data: string) {
    assert.ok(this.onInput, "Native TUI must own terminal input");
    this.onInput(data);
  }
  resize(rows: number, columns = this.columns) {
    this.rows = rows;
    this.columns = columns;
    this.onResize?.();
  }
}

const nextRender = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

test("native ask UI answers and cancels without consuming the main editor draft", { timeout: 20_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-ask-native-"));
  const agentDir = join(home, ".pi", "agent");
  const otherCwd = join(home, "other-project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(otherCwd);
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Keep all imports and host initialization inside the isolated profile.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network in native UI test"); });
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const pi = await import("@earendil-works/pi-coding-agent");
    let commandContext: ExtensionCommandContext | undefined;
    let promptAfterLaterExtension = "";
    const settingsManager = pi.SettingsManager.inMemory({ theme: "dark", quietStartup: true });
    const modelRuntime = await pi.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false,
    });
    const runtime = await pi.createAgentSessionRuntime(async ({ cwd, sessionManager }) => {
      const services = await pi.createAgentSessionServices({
        cwd, agentDir, modelRuntime, settingsManager,
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          additionalExtensionPaths: [fileURLToPath(new URL("../extensions/ask-question.ts", import.meta.url))],
          extensionFactories: [(api) => {
            api.registerCommand("test-ui-context", {
              handler: async (_args, ctx) => { commandContext = ctx; },
            });
            api.on("before_agent_start", (event) => {
              event.systemPromptOptions.cwd = otherCwd;
              event.systemPromptOptions.sections.policy = "Confirm destructive actions.";
              promptAfterLaterExtension = event.systemPrompt;
            });
          }],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      return {
        ...await pi.createAgentSessionFromServices({ services, sessionManager, tools: ["ask_question"] }),
        services, diagnostics: services.diagnostics,
      };
    }, { cwd: home, agentDir, sessionManager: pi.SessionManager.inMemory(home) });
    const terminal = new MemoryTerminal();
    const mode = new pi.InteractiveMode(runtime, { terminal, initialThemeSetting: "dark" });
    cleanup = async () => {
      try { mode.stop(); } finally { await runtime.dispose(); }
    };
    await mode.init();
    await runtime.session.prompt("/test-ui-context");
    assert.ok(commandContext);
    const ui = commandContext.ui;
    const tool = runtime.session.agent.state.tools.find((tool) => tool.name === "ask_question");
    assert.ok(tool, "Native loader must register and activate ask_question");
    const renderer = () => (mode as unknown as { renderer: {
      mode: "regular" | "fullscreen";
      previousLines?: string[];
      previousScreen?: string[];
    } }).renderer;
    const viewport = () => (renderer().mode === "fullscreen" ? renderer().previousScreen : renderer().previousLines)?.slice(-terminal.rows) ?? [];
    const switchMode = (next: "regular" | "fullscreen") =>
      (mode as unknown as { switchTuiMode: (mode: "regular" | "fullscreen") => boolean }).switchTuiMode(next);

    await t.test("grill-me preserves instructions added by a later extension", async () => {
      try {
        await runtime.session.prompt("/grill-me on");
        await runtime.session.extensionRunner.emitBeforeAgentStart("test", undefined, { cwd: home, selectedTools: ["ask_question"] });
        assert.ok(promptAfterLaterExtension.includes(`<cwd>\n${otherCwd}\n</cwd>`), "The model sees the updated working directory");
        assert.match(promptAfterLaterExtension, /Confirm destructive actions\./);
        assert.match(promptAfterLaterExtension, /\/grill-me mode is active/);
      } finally {
        await runtime.session.prompt("/grill-me off");
      }
    });

    for (const action of ["answer", "escape", "abort"] as const) {
      await t.test(action, async () => {
        ui.setEditorText("untouched draft");
        // Let the native differential renderer remove the previous dialog first.
        await nextRender();
        terminal.output = "";
        const controller = new AbortController();
        const execution = tool.execute(`native-${action}`, {
          question: "Native choice?", options: ["First", "Second"],
        }, controller.signal);
        try {
          await nextRender();
          assert.match(terminal.output, /Native choice\?/);
          // These bytes go through Pi's real terminal dispatcher and focus routing.
          if (action === "answer") {
            terminal.send("\x1b[B");
            terminal.send("\r");
          } else if (action === "escape") terminal.send("\x1b");
          else controller.abort();
          const result = await execution;
          const details = result.details as { cancelled: boolean; timedOut: boolean; answers: { answer: string }[] };
          assert.equal(details.cancelled, action !== "answer");
          assert.equal(details.timedOut, false);
          assert.deepEqual(details.answers.map((answer) => answer.answer), action === "answer" ? ["Second"] : []);
          assert.equal(ui.getEditorText(), "untouched draft");
          terminal.send("!");
          assert.equal(ui.getEditorText(), "untouched draft!", "Closing custom UI restores editor input ownership");
        } finally {
          controller.abort();
          await execution;
        }
      });
    }

    await t.test("long choices stay visible with a below-editor widget and height-only resize", async () => {
      ui.setEditorText("untouched draft");
      ui.setStatus("native-test", "footer status");
      terminal.resize(24);
      const controller = new AbortController();
      const options = Array.from({ length: 30 }, (_, index) => `Native choice ${String(index + 1).padStart(2, "0")}`);
      const execution = tool.execute("native-long-list", { question: "Native long list?", options }, controller.signal);
      const assertVisible = (choice: string) => {
        const rows = viewport();
        assert.ok(rows.some((line) => line.includes("Native long list?")), "The question is on screen");
        assert.ok(rows.some((line) => line.includes(">") && line.includes(choice)), `${choice} is selected on screen`);
      };
      try {
        await nextRender();
        assertVisible("Native choice 01");
        ui.setWidget("native-below", Array.from({ length: 4 }, (_, index) => `Below ${index}`), { placement: "belowEditor" });
        await nextRender();
        assertVisible("Native choice 01");
        terminal.resize(15);
        await nextRender();
        assertVisible("Native choice 01");
        terminal.resize(24);
        for (let index = 0; index < 29; index += 1) terminal.send("\x1b[B");
        await nextRender();
        assertVisible("Native choice 30");
        terminal.send("\r");
        const result = await execution;
        assert.deepEqual((result.details as { answers: { answer: string }[] }).answers.map((answer) => answer.answer), ["Native choice 30"]);
        assert.equal(ui.getEditorText(), "untouched draft");
        await nextRender();
        assert.ok(renderer().previousLines?.some((line) => line.includes("footer status")), "Footer returns when the question closes");
      } finally {
        controller.abort();
        await execution;
        ui.setWidget("native-below", undefined);
        ui.setStatus("native-test", undefined);
        terminal.resize(40);
      }
    });

    await t.test("fullscreen keeps the selected choice visible above a tall below-editor widget", async () => {
      ui.setWidget("native-below", Array.from({ length: 8 }, (_, index) => `Below ${index}`), { placement: "belowEditor" });
      terminal.resize(24);
      assert.equal(switchMode("fullscreen"), true);
      const controller = new AbortController();
      const options = Array.from({ length: 30 }, (_, index) => `Fullscreen choice ${String(index + 1).padStart(2, "0")}`);
      const execution = tool.execute("native-fullscreen-list", { question: "Fullscreen choices?", options }, controller.signal);
      try {
        await nextRender();
        assert.ok(viewport().some((line) => line.includes("Fullscreen choices?")));
        assert.ok(viewport().some((line) => line.includes(">") && line.includes("Fullscreen choice 01")));
        for (let index = 0; index < 29; index += 1) terminal.send("\x1b[B");
        await nextRender();
        assert.ok(viewport().some((line) => line.includes(">") && line.includes("Fullscreen choice 30")));
        terminal.send("\r");
        const result = await execution;
        assert.equal((result.details as { answers: { answer: string }[] }).answers[0]?.answer, "Fullscreen choice 30");
      } finally {
        controller.abort();
        await execution;
        switchMode("regular");
        ui.setWidget("native-below", undefined);
        terminal.resize(40);
      }
    });

    await t.test("many multi-select answers do not push the highlighted choice offscreen", async () => {
      terminal.resize(24);
      const controller = new AbortController();
      const options = Array.from({ length: 30 }, (_, index) => `Choice ${String(index + 1).padStart(2, "0")} ${"details ".repeat(12)}end-${index + 1}`);
      const execution = tool.execute("native-many-selections", { question: "Select several?", options, multiSelect: true }, controller.signal);
      try {
        await nextRender();
        for (let index = 0; index < 20; index += 1) {
          terminal.send(" ");
          terminal.send("\x1b[B");
        }
        await nextRender();
        assert.ok(viewport().some((line) => line.includes("Select several?")), "Question stays on screen");
        assert.ok(viewport().some((line) => line.includes(">") && line.includes("Choice 21")), "Highlighted choice stays on screen");
        assert.ok(viewport().some((line) => line.includes("Current answer:") && line.includes("…")), "Selected answers still have a compact preview");
        for (let index = 0; index < 10; index += 1) terminal.send("\x1b[B");
        terminal.send("\r");
        terminal.send("SPECIAL-CUSTOM");
        terminal.send("\r");
        await nextRender();
        assert.ok(viewport().some((line) => line.includes("Current answer:") && line.includes("SPECIAL-CUSTOM")), "Saved custom choice stays identifiable");
        terminal.send("\x1b[C");
        terminal.send("\r");
        const result = await execution;
        assert.equal((result.details as { answers: { answer: string }[] }).answers[0]?.answer, `${options.slice(0, 20).join(", ")}, SPECIAL-CUSTOM`);
      } finally {
        controller.abort();
        await execution;
        terminal.resize(40);
      }
    });

    await t.test("a saved long custom answer keeps its choice visible and its review readable", async () => {
      terminal.resize(24);
      const controller = new AbortController();
      const answer = `START-MARKER ${"word ".repeat(400)}END-MARKER`;
      const execution = tool.execute("native-revisit", {
        questions: [
          { question: "First question?", options: ["Recommended"] },
          { question: "Second question?", options: ["Yes"] },
        ],
      }, controller.signal);
      try {
        await nextRender();
        terminal.send("\x1b[B");
        terminal.send("\r");
        terminal.send(answer);
        terminal.send("\r");
        terminal.send("\x1b[D");
        await nextRender();
        assert.ok(viewport().some((line) => line.includes("First question?")), "Question remains visible after a long saved answer");
        assert.ok(viewport().some((line) => line.includes(">") && line.includes("Recommended")), "Current highlighted choice remains visible");
        assert.ok(viewport().some((line) => line.includes("Current answer:") && line.includes("…")), "Saved answer is previewed on one line");
        assert.ok(viewport().some((line) => line.includes("Auto-continues after 5 minutes")), "Help remains visible after revisiting");

        terminal.send("\x1b[C");
        terminal.send("\r");
        await nextRender();
        assert.ok(viewport().some((line) => line.includes("question_2: Yes")), "Review shows the last answer");
        assert.ok(viewport().some((line) => line.includes("to submit")), "Review shows the submission action");
        for (let index = 0; index < 10 && !viewport().some((line) => line.includes("START-MARKER")); index += 1) {
          terminal.send("\x1b[5~");
          await nextRender();
        }
        assert.ok(viewport().some((line) => line.includes("START-MARKER")), "PageUp reveals the beginning of a long reviewed answer");
        for (let index = 0; index < 10 && !viewport().some((line) => line.includes("to submit")); index += 1) {
          terminal.send("\x1b[6~");
          await nextRender();
        }
        assert.ok(viewport().some((line) => line.includes("to submit")), "PageDown returns to the submission action");
        terminal.send("\r");
        const result = await execution;
        assert.deepEqual((result.details as { answers: { answer: string }[] }).answers.map((entry) => entry.answer), [answer.trim(), "Yes"]);
      } finally {
        controller.abort();
        await execution;
        terminal.resize(40);
      }
    });

    await t.test("custom editing stays readable on a 15-row terminal", async () => {
      ui.setEditorText("untouched draft");
      terminal.resize(15);
      const controller = new AbortController();
      const options = Array.from({ length: 30 }, (_, index) => `Choice ${index + 1}`);
      const execution = tool.execute("native-short-edit", { question: "Custom details?", options, multiSelect: true }, controller.signal);
      const answer = `${"word ".repeat(250)}EDIT-END-MARKER`;
      try {
        await nextRender();
        for (let index = 0; index < 30; index += 1) terminal.send("\x1b[B");
        terminal.send("\r");
        terminal.send(answer);
        await nextRender();
        const rows = viewport();
        assert.ok(rows.some((line) => line.includes("Custom details?")), "Question stays visible while editing");
        assert.ok(rows.some((line) => line.includes(">") && line.includes("Type a custom answer")), "Selected custom choice stays visible");
        assert.ok(rows.some((line) => line.includes("Your answer:")), "Editor label stays visible");
        assert.ok(rows.some((line) => line.includes("EDIT-END-MARKER")), "The editor's active line and caret stay on screen");

        terminal.send("\r");
        terminal.send("\x1b[C");
        terminal.send("\r");
        const result = await execution;
        assert.deepEqual((result.details as { answers: { answer: string }[] }).answers.map((entry) => entry.answer), [answer]);
        assert.equal(ui.getEditorText(), "untouched draft");
      } finally {
        controller.abort();
        await execution;
        terminal.resize(40);
      }
    });

    await t.test("long selected labels can be paged without changing the answer", async () => {
      terminal.resize(24);
      const longChoice = `${"word ".repeat(500)}END-MARKER`;
      try {
        for (const tuiMode of ["regular", "fullscreen"] as const) {
          assert.equal(switchMode(tuiMode), true);
          const pageDown = tuiMode === "fullscreen" ? "\x1b[6;2~" : "\x1b[6~";
          const pageUp = tuiMode === "fullscreen" ? "\x1b[5;2~" : "\x1b[5~";
          const controller = new AbortController();
          const execution: Promise<{ details: unknown }> = tool.execute(
            `native-long-label-${tuiMode}`, { question: "Read the whole choice?", options: [longChoice, "Short choice"] }, controller.signal,
          );
          try {
            await nextRender();
            assert.ok(viewport().some((line) => line.includes("Read the whole choice?")));
            assert.ok(viewport().some((line) => line.includes("> 1.")));
            assert.ok(!viewport().some((line) => line.includes("END-MARKER")), "Tail starts below the viewport");

            for (let index = 0; index < 10 && !viewport().some((line) => line.includes("END-MARKER")); index += 1) {
              terminal.send(pageDown);
              await nextRender();
            }
            assert.ok(viewport().some((line) => line.includes("END-MARKER")), `${tuiMode} PageDown reveals the label tail`);
            for (let index = 0; index < 10 && !viewport().some((line) => line.includes("> 1.")); index += 1) {
              terminal.send(pageUp);
              await nextRender();
            }
            assert.ok(viewport().some((line) => line.includes("> 1.")), `${tuiMode} PageUp returns to the label start`);
            terminal.send("\r");
            const result = await execution;
            assert.equal((result.details as { answers: { answer: string }[] }).answers[0]?.answer, longChoice);
          } finally {
            controller.abort();
            await execution;
          }
        }
      } finally {
        if (renderer().mode === "fullscreen") switchMode("regular");
        terminal.resize(40);
      }
    });

    await t.test("a wrapped question can be paged while its selected choice stays visible", async () => {
      terminal.resize(15, 40);
      const question = `Which option? ${"context ".repeat(70)}QUESTION-END`;
      const options = Array.from({ length: 30 }, (_, index) => `Choice ${index + 1}`);
      try {
        for (const tuiMode of ["regular", "fullscreen"] as const) {
          assert.equal(switchMode(tuiMode), true);
          const pageDown = tuiMode === "fullscreen" ? "\x1b[6;2~" : "\x1b[6~";
          const pageUp = tuiMode === "fullscreen" ? "\x1b[5;2~" : "\x1b[5~";
          const controller = new AbortController();
          const execution: Promise<{ details: unknown }> = tool.execute(`native-long-question-${tuiMode}`, { question, options }, controller.signal);
          try {
            await nextRender();
            assert.ok(viewport().some((line) => line.includes("Which option?")));
            assert.ok(viewport().some((line) => line.includes(">") && line.includes("Choice 1")), "Selected choice is visible");
            assert.ok(!viewport().some((line) => line.includes("QUESTION-END")), "Question tail starts below its page");
            assert.ok(viewport().some((line) => line.includes("pageUp/pageDown")), "Question paging keys are visible");
            for (let index = 0; index < 10 && !viewport().some((line) => line.includes("QUESTION-END")); index += 1) {
              terminal.send(pageDown);
              await nextRender();
              assert.ok(viewport().some((line) => line.includes(">") && line.includes("Choice 1")), "Paging the question keeps the choice visible");
            }
            assert.ok(viewport().some((line) => line.includes("QUESTION-END")), "PageDown reveals the rest of the question");
            for (let index = 0; index < 10 && !viewport().some((line) => line.includes("Which option?")); index += 1) {
              terminal.send(pageUp);
              await nextRender();
            }
            assert.ok(viewport().some((line) => line.includes("Which option?")), "PageUp returns to the question start");
            terminal.send("\r");
            const result = await execution;
            assert.equal((result.details as { answers: { answer: string }[] }).answers[0]?.answer, "Choice 1");
          } finally {
            controller.abort();
            await execution;
          }

          const editController = new AbortController();
          const editExecution: Promise<{ details: unknown }> = tool.execute(
            `native-edit-question-${tuiMode}`, { question, options }, editController.signal,
          );
          try {
            await nextRender();
            for (let index = 0; index < 30; index += 1) terminal.send("\x1b[B");
            terminal.send("\r");
            terminal.send("Draft work");
            await nextRender();
            const firstPage = viewport().find((line) => line.includes("Q 1-"));
            assert.ok(firstPage?.includes("Shift+PageUp"), "The distinct edit-mode question shortcut is visible");
            assert.ok(viewport().some((line) => line.includes("Draft work")), "The custom draft is visible");
            terminal.send("\x1b[6~");
            await nextRender();
            assert.equal(viewport().find((line) => line.includes("Q 1-")), firstPage, "Plain PageDown remains with the editor");
            for (let index = 0; index < 10 && !viewport().some((line) => line.includes("QUESTION-END")); index += 1) {
              terminal.send("\x1b[6;2~");
              await nextRender();
            }
            assert.ok(viewport().some((line) => line.includes("QUESTION-END")), "Shift+PageDown reads the question while editing");
            assert.ok(viewport().some((line) => line.includes("Draft work")), "Question paging preserves the custom draft");
            assert.ok(viewport().some((line) => line.includes(">") && line.includes("Type a custom answer")), "The choice stays visible");
            terminal.send("\r");
            const result = await editExecution;
            assert.equal((result.details as { answers: { answer: string }[] }).answers[0]?.answer, "Draft work");
          } finally {
            editController.abort();
            await editExecution;
          }
        }
      } finally {
        if (renderer().mode === "fullscreen") switchMode("regular");
        terminal.resize(40, 80);
      }
    });
  } finally {
    try { await cleanup?.(); } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  }
});
