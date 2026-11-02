import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionRunner,
} from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";
import type { WaitingPromptState } from "../extensions/lib/remote-answers.ts";
import type { Answer, AskQuestionDetails } from "../extensions/lib/types.ts";

type LegacyBeforeAgentStart = (
  prompt: string,
  images: undefined,
  options: BuildSystemPromptOptions,
) => ReturnType<ExtensionRunner["emitBeforeAgentStart"]>;
type TriggerBeforeAgentStart = (
  trigger: { messageType: "user"; prompt: string },
  options: BuildSystemPromptOptions,
) => ReturnType<ExtensionRunner["emitBeforeAgentStart"]>;

function usesLegacyBeforeAgentStart(
  emit: LegacyBeforeAgentStart | TriggerBeforeAgentStart,
): emit is LegacyBeforeAgentStart {
  // Official Pi 1.1.0 takes three arguments; newer hosts take a trigger and options.
  return emit.length === 3;
}

function emitUserBeforeAgentStart(
  runner: { emitBeforeAgentStart: LegacyBeforeAgentStart | TriggerBeforeAgentStart },
  prompt: string,
  options: BuildSystemPromptOptions,
) {
  const emit: LegacyBeforeAgentStart | TriggerBeforeAgentStart =
    runner.emitBeforeAgentStart.bind(runner);
  return usesLegacyBeforeAgentStart(emit)
    ? emit(prompt, undefined, options)
    : emit({ messageType: "user", prompt }, options);
}

// Use Pi's public Terminal injection, as its native TUI tests do. No process
// terminal, clipboard, renderer mock, or custom() double participates here.
class MemoryTerminal implements Terminal {
  columns = 80;
  rows = 40;
  kittyProtocolActive = false;
  output = "";
  onInput?: ((data: string) => void) | undefined;
  onResize?: (() => void) | undefined;
  start(onInput: (data: string) => void, onResize: () => void) {
    this.onInput = onInput;
    this.onResize = onResize;
  }
  stop() {
    this.onInput = undefined;
    this.onResize = undefined;
  }
  async drainInput() {
    // Intentional no-op: the memory terminal has no input queue.
  }
  write(data: string) {
    this.output += data;
  }
  moveBy(_lines: number) {
    // Intentional no-op: tests do not observe cursor motion.
  }
  hideCursor() {
    // Intentional no-op: tests do not observe cursor visibility.
  }
  showCursor() {
    // Intentional no-op: tests do not observe cursor visibility.
  }
  clearLine() {
    // Intentional no-op: output history stays append-only for assertions.
  }
  clearFromCursor() {
    // Intentional no-op: output history stays append-only for assertions.
  }
  clearScreen() {
    // Intentional no-op: output history stays append-only for assertions.
  }
  setTitle(_title: string) {
    // Intentional no-op: tests do not observe terminal titles.
  }
  setProgress(_active: boolean) {
    // Intentional no-op: tests do not observe progress indicators.
  }
  setProgramStatus(_status: unknown) {
    // Intentional no-op: tests do not observe program status.
  }
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

const nextRender = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 30);
  });

/** A published bus state: waiting details or the closed notice. */
type BusState = WaitingPromptState | { status: "closed"; promptId: string };

/** A result receipt emitted for one remote answer request. */
type Receipt = { requestId: string; promptId: string; status: string };

/** A lookup-result event as the tests read it. */
type LookupResult = { status: string; questionId?: string; answerFingerprint?: string };

/** The recorded answer at an index, asserted present. */
function answerAt(details: AskQuestionDetails, index: number): Answer {
  const answer = details.answers[index];
  assert.ok(answer !== undefined);
  return answer;
}

/** The last element of a recorded array, asserted present. */
function lastOf<T>(values: T[]): T {
  const value = values.at(-1);
  assert.ok(value !== undefined);
  return value;
}

/** Shape check for a bus state event. */
function isBusState(value: unknown): value is BusState {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value.status === "waiting" || value.status === "closed")
  );
}

/** Shape check for a result receipt event. */
function isReceipt(value: unknown): value is Receipt {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof value.status === "string" &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    "promptId" in value &&
    typeof value.promptId === "string"
  );
}

/** Shape check for a snapshot event. */
function isWaitingState(value: unknown): value is WaitingPromptState {
  return isBusState(value) && value.status === "waiting";
}

/** Shape check for a lookup-result event. */
function isLookupResult(value: unknown): value is LookupResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof value.status === "string"
  );
}

/** The last bus state, asserted to be a waiting state. */
function waitingState(states: BusState[]): WaitingPromptState {
  const state = lastOf(states);
  assert.ok(state.status === "waiting");
  return state;
}

/** Shape check for ask_question result details. */
function askDetails(result: { details: unknown }): AskQuestionDetails {
  assert.ok(isAskDetails(result.details));
  return result.details;
}
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

nodeTest(
  "native ask UI answers and cancels without consuming the main editor draft",
  { timeout: 20_000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "pi-ask-native-"));
    const agentDir = join(home, ".pi", "agent");
    const otherCwd = join(home, "other-project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(otherCwd);
    const previous = {
      HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    };
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // Keep all imports and host initialization inside the isolated profile.
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("No network in native UI test");
    });
    let cleanup: (() => Promise<void>) | undefined;
    try {
      const pi = await import("@earendil-works/pi-coding-agent");
      let commandContext: ExtensionCommandContext | undefined;
      let events: ExtensionAPI["events"] | undefined;
      let promptAfterLaterExtension = "";
      const settingsManager = pi.SettingsManager.inMemory({ theme: "dark", quietStartup: true });
      const modelRuntime = await pi.ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
      });
      const runtime = await pi.createAgentSessionRuntime(
        async ({ cwd, sessionManager }) => {
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
              additionalExtensionPaths: [
                fileURLToPath(new URL("../extensions/ask-question.ts", import.meta.url)),
              ],
              extensionFactories: [
                (api) => {
                  events = api.events;
                  api.registerCommand("test-ui-context", {
                    handler: async (_args, ctx) => {
                      commandContext = ctx;
                    },
                  });
                  api.on("before_agent_start", (event) => {
                    // oxlint-disable-next-line eslint/no-param-reassign -- QX-002: Pi documents systemPromptOptions as mutable by handlers; these assignments verify that same supported contract from a test extension.
                    event.systemPromptOptions.cwd = otherCwd;
                    // oxlint-disable-next-line eslint/no-param-reassign -- QX-002: same supported mutation contract, policy section.
                    event.systemPromptOptions.sections.policy = "Confirm destructive actions.";
                    promptAfterLaterExtension = event.systemPrompt;
                  });
                },
              ],
            },
          });
          assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
          return {
            ...(await pi.createAgentSessionFromServices({
              services,
              sessionManager,
              tools: ["ask_question"],
            })),
            services,
            diagnostics: services.diagnostics,
          };
        },
        { cwd: home, agentDir, sessionManager: pi.SessionManager.inMemory(home) },
      );
      const terminal = new MemoryTerminal();
      const mode = new pi.InteractiveMode(runtime, { terminal, initialThemeSetting: "dark" });
      cleanup = async () => {
        try {
          mode.stop();
        } finally {
          await runtime.dispose();
        }
      };
      await mode.init();
      await runtime.session.prompt("/test-ui-context");
      assert.ok(commandContext);
      assert.ok(events !== undefined);
      // Extensions reload reassigns both captured objects; these accessors re-read
      // the live variables so post-reload calls hit the fresh bus and ctx.
      const bus = (): ExtensionAPI["events"] => {
        assert.ok(events !== undefined);
        return events;
      };
      const ctx = (): ExtensionCommandContext => {
        assert.ok(commandContext !== undefined);
        return commandContext;
      };
      const ui = commandContext.ui;
      const tool = runtime.session.agent.state.tools.find(
        (registered) => registered.name === "ask_question",
      );
      assert.ok(tool, "Native loader must register and activate ask_question");
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-006: InteractiveMode keeps renderer and switchTuiMode private (dist/modes/interactive/interactive-mode.d.ts:44,139); Pi's own native TUI tests probe them the same way, and the installed Pi release exposes no public accessor or mode-switching API.
      const modeInternals = mode as unknown as {
        renderer: {
          mode: "regular" | "fullscreen";
          previousLines?: string[];
          previousScreen?: string[];
        };
        switchTuiMode: (mode: "regular" | "fullscreen") => boolean;
      };
      const renderer = () => modeInternals.renderer;
      const viewport = () =>
        (renderer().mode === "fullscreen"
          ? renderer().previousScreen
          : renderer().previousLines
        )?.slice(-terminal.rows) ?? [];
      const switchMode = (next: "regular" | "fullscreen") => modeInternals.switchTuiMode(next);
      assert.equal(renderer().mode, "fullscreen", "Pi 1.0 defaults to fullscreen");

      await t.test("grill-me preserves instructions added by a later extension", async () => {
        try {
          await runtime.session.prompt("/grill-me on");
          await emitUserBeforeAgentStart(runtime.session.extensionRunner, "test", {
            cwd: home,
            selectedTools: ["ask_question"],
          });
          assert.ok(
            promptAfterLaterExtension.includes(`<cwd>\n${otherCwd}\n</cwd>`),
            "The model sees the updated working directory",
          );
          assert.match(promptAfterLaterExtension, /Confirm destructive actions\./);
          assert.match(promptAfterLaterExtension, /\/grill-me mode is active/);
        } finally {
          await runtime.session.prompt("/grill-me off");
        }
      });

      for (const tuiMode of ["fullscreen", "regular"] as const) {
        await t.test(`${tuiMode} keeps the preceding context visible while answering`, async () => {
          terminal.resize(24);
          assert.equal(switchMode(tuiMode), true);
          ui.setEditorText("untouched context draft");
          await runtime.session.sendCustomMessage({
            customType: "test-context",
            content: [
              ...Array.from({ length: 20 }, (_, index) => `Context detail ${index + 1}.`),
              "Final detail needed for the decision.",
            ].join("\n"),
            display: true,
          });
          await nextRender();
          assert.ok(
            viewport().some((line) => line.includes("Final detail needed for the decision.")),
          );

          const controller = new AbortController();
          const execution = tool.execute(
            "native-context",
            {
              question: "Which option?",
              options: ["First", "Second", "Third"],
            },
            controller.signal,
          );
          try {
            await nextRender();
            const rows = viewport();
            assert.ok(
              rows.some((line) => line.includes("Which option?")),
              "The question is visible",
            );
            assert.ok(
              rows.some((line) => line.includes("Final detail needed for the decision.")),
              "The preceding context is visible",
            );
            terminal.send("\x0f");
            await nextRender();
            assert.ok(
              viewport().some((line) => line.includes("return to question")),
              "The context view explains how to return",
            );
            assert.ok(
              viewport().some((line) => line.includes("Final detail needed for the decision.")),
            );
            if (tuiMode === "fullscreen") {
              terminal.send("\x1b[5~");
              await nextRender();
              assert.ok(
                viewport().some((line) => line.includes("Context detail 1.")),
                "PageUp reads earlier context",
              );
            }
            terminal.send("?");
            assert.equal(ui.getEditorText(), "untouched context draft");
            terminal.send("\x0f");
            await nextRender();
            assert.ok(
              viewport().some((line) => line.includes("Which option?")),
              "The question returns without cancelling",
            );
            if (tuiMode === "fullscreen") {
              const hintRow =
                viewport().findIndex((line) => line.includes("ctrl+o read context")) + 1;
              assert.ok(hintRow > 0);
              const click = (column: number, row: number) => {
                terminal.send(`\x1b[<0;${column};${row}M`);
                terminal.send(`\x1b[<0;${column};${row}m`);
              };
              click(terminal.columns, hintRow);
              await nextRender();
              assert.ok(
                viewport().some((line) => line.includes("Which option?")),
                "The border does not activate the hint",
              );
              click(1, hintRow);
              await nextRender();
              const returnRow =
                viewport().findIndex((line) => line.includes("return to question")) + 1;
              assert.ok(returnRow > 0, "Clicking the hint opens the context");
              click(1, returnRow);
              await nextRender();
              assert.ok(
                viewport().some((line) => line.includes("Which option?")),
                "Clicking the return hint restores the question",
              );
            }
            terminal.send("\r");
            const result = await execution;
            assert.equal(answerAt(askDetails(result), 0).answer, "First");
          } finally {
            controller.abort();
            await execution;
            terminal.resize(40);
          }
        });
      }

      for (const tuiMode of ["fullscreen", "regular"] as const) {
        await t.test(
          `${tuiMode} restores editor input when a question closes in context view`,
          async () => {
            terminal.resize(24);
            assert.equal(switchMode(tuiMode), true);
            ui.setEditorText("saved draft");
            const controller = new AbortController();
            const execution = tool.execute(
              "native-context-abort",
              { question: "Continue?" },
              controller.signal,
            );
            try {
              await nextRender();
              terminal.send("\x0f");
              await nextRender();
              assert.ok(viewport().some((line) => line.includes("return to question")));
              controller.abort();
              const result = await execution;
              assert.equal(askDetails(result).cancelled, true);
              terminal.send("!");
              assert.equal(ui.getEditorText(), "saved draft!");
            } finally {
              controller.abort();
              await execution;
              terminal.resize(40);
            }
          },
        );
      }

      for (const [tuiMode, modeAction] of (["fullscreen", "regular"] as const).flatMap((uiMode) =>
        (["answer", "escape", "abort"] as const).map((uiAction) => [uiMode, uiAction] as const),
      )) {
        switchMode(tuiMode);
        await t.test(`${tuiMode} ${modeAction}`, async () => {
          ui.setEditorText("untouched draft");
          // Let the native differential renderer remove the previous dialog first.
          await nextRender();
          terminal.output = "";
          const controller = new AbortController();
          const execution = tool.execute(
            `native-${modeAction}`,
            {
              question: "Native choice?",
              options: ["First", "Second"],
            },
            controller.signal,
          );
          try {
            await nextRender();
            assert.match(terminal.output, /Native choice\?/);
            // These bytes go through Pi's real terminal dispatcher and focus routing.
            if (modeAction === "answer") {
              terminal.send("\x1b[B");
              terminal.send("\r");
            } else if (modeAction === "escape") {
              terminal.send("\x1b");
            } else {
              controller.abort();
            }
            const result = await execution;
            const details = askDetails(result);
            assert.equal(details.cancelled, modeAction !== "answer");
            assert.equal(details.timedOut, false);
            assert.deepEqual(
              details.answers.map((answer) => answer.answer),
              modeAction === "answer" ? ["Second"] : [],
            );
            assert.equal(ui.getEditorText(), "untouched draft");
            terminal.send("!");
            assert.equal(
              ui.getEditorText(),
              "untouched draft!",
              "Closing custom UI restores editor input ownership",
            );
          } finally {
            controller.abort();
            await execution;
          }
        });
      }

      for (const tuiMode of ["fullscreen", "regular"] as const) {
        switchMode(tuiMode);
        await t.test(
          `${tuiMode} cooperative remote answer uses native completion and restores editor ownership`,
          async () => {
            ui.setEditorText("untouched remote draft");
            const controller = new AbortController();
            const states: BusState[] = [];
            const snapshots: WaitingPromptState[] = [];
            const lookups: LookupResult[] = [];
            const receipts: Receipt[] = [];
            const unsubscribeState = bus().on("pi-ask-question:state", (data) => {
              assert.ok(isBusState(data));
              states.push(data);
            });
            const unsubscribeResult = bus().on("pi-ask-question:result", (data) => {
              assert.ok(isReceipt(data));
              receipts.push(data);
            });
            const unsubscribeSnapshot = bus().on("pi-ask-question:snapshot", (data) => {
              assert.ok(isWaitingState(data));
              snapshots.push(data);
            });
            const unsubscribeLookup = bus().on("pi-ask-question:lookup-result", (data) => {
              assert.ok(isLookupResult(data));
              lookups.push(data);
            });
            const execution = tool.execute(
              "native-remote",
              {
                questions: [
                  { id: "first", question: "Remote first?", options: ["Yes"] },
                  {
                    id: "many",
                    question: "Remote parts?",
                    options: ["A", "B, C"],
                    multiSelect: true,
                  },
                ],
              },
              controller.signal,
            );
            try {
              await nextRender();
              bus().emit("pi-ask-question:query", { protocolVersion: 1, queryId: "late-native" });
              const initial = lastOf(snapshots);
              assert.equal(initial.status, "waiting");
              assert.equal(initial.nativeRoot, runtime.session.sessionManager.getSessionId());
              assert.equal(initial.deadline, waitingState(states).deadline);
              assert.ok(initial.deadline > Date.now() && initial.deadline <= Date.now() + 300_000);
              assert.ok(viewport().some((line) => line.includes("Remote first?")));
              bus().emit("pi-ask-question:answer", {
                ...initial,
                requestId: "native-first",
                answer: "Yes",
              });
              await nextRender();
              const next = waitingState(states);
              assert.equal(next.questionId, "many");
              assert.ok(
                viewport().some((line) => line.includes("Remote parts?")),
                "Native UI advances to the real next question",
              );
              bus().emit("pi-ask-question:answer", {
                ...initial,
                requestId: "native-stale",
                answer: "wrong",
              });
              assert.equal(lastOf(receipts).status, "stale");
              bus().emit("pi-ask-question:answer", {
                ...next,
                requestId: "native-last",
                answer: ["B, C", "A"],
              });
              const result = await execution;
              const details = askDetails(result);
              assert.equal(details.cancelled, false);
              assert.equal(answerAt(details, 0).answer, "Yes");
              assert.equal(
                answerAt(details, 0).wasCustom,
                true,
                "An exact option string is still literal custom input",
              );
              assert.deepEqual(answerAt(details, 1).selectedOptions, ["B, C", "A"]);
              assert.equal(lastOf(receipts).status, "answered");
              receipts.length = 0;
              bus().emit("pi-ask-question:lookup", {
                protocolVersion: 1,
                queryId: "lost-native-result",
                nativeRoot: initial.nativeRoot,
                ownerGeneration: initial.ownerGeneration,
                promptId: initial.promptId,
                requestId: "native-last",
              });
              assert.equal(lastOf(lookups).status, "answered");
              assert.equal(lastOf(lookups).questionId, "many");
              assert.equal(lastOf(states).status, "closed");
              assert.equal(ui.getEditorText(), "untouched remote draft");
              terminal.send("!");
              assert.equal(ui.getEditorText(), "untouched remote draft!");
              const receiptCount = receipts.length;
              bus().emit("pi-ask-question:answer", {
                ...next,
                requestId: "native-last",
                answer: ["A"],
              });
              assert.equal(
                receipts.length,
                receiptCount,
                "Completed native owner has unsubscribed",
              );
            } finally {
              controller.abort();
              await execution;
              unsubscribeState();
              unsubscribeResult();
              unsubscribeSnapshot();
              unsubscribeLookup();
            }
          },
        );
      }

      for (const tuiMode of ["fullscreen", "regular"] as const) {
        switchMode(tuiMode);
        await t.test(
          `${tuiMode} preserves typed answers past the original deadline`,
          async (sub) => {
            let now = Date.now();
            sub.mock.method(Date, "now", () => now);
            const controller = new AbortController();
            const snapshots: WaitingPromptState[] = [];
            const unsubscribe = bus().on("pi-ask-question:snapshot", (data) => {
              assert.ok(isWaitingState(data));
              snapshots.push(data);
            });
            const execution = tool.execute(
              "native-timeout",
              {
                questions: [{ question: "Details?" }, { question: "Next?", options: ["Continue"] }],
              },
              controller.signal,
            );
            try {
              await nextRender();
              terminal.send("\r");
              terminal.send("A lengthy answer");
              await nextRender();
              assert.ok(
                viewport().some((line) => line.includes("No time limit while you answer.")),
              );
              now += 300_001;
              terminal.send("\r");
              await nextRender();
              bus().emit("pi-ask-question:query", { protocolVersion: 1, queryId: "after-typing" });
              assert.equal(lastOf(snapshots).status, "waiting");
              assert.equal(lastOf(snapshots).timeoutActive, false);
              terminal.send("\r");
              terminal.send("\r");
              const details = askDetails(await execution);
              assert.equal(details.timedOut, false);
              assert.deepEqual(
                details.answers.map((answer) => answer.answer),
                ["A lengthy answer", "Continue"],
              );
            } finally {
              controller.abort();
              await execution;
              unsubscribe();
            }
          },
        );
      }

      for (const tuiMode of ["fullscreen", "regular"] as const) {
        switchMode(tuiMode);
        await t.test(
          `${tuiMode} long choices stay visible with a below-editor widget and height-only resize`,
          async () => {
            ui.setEditorText("untouched draft");
            ui.setStatus("native-test", "footer status");
            terminal.resize(24);
            const controller = new AbortController();
            const options = Array.from(
              { length: 30 },
              (_, index) => `Native choice ${String(index + 1).padStart(2, "0")}`,
            );
            const execution = tool.execute(
              "native-long-list",
              { question: "Native long list?", options },
              controller.signal,
            );
            const assertVisible = (choice: string) => {
              const rows = viewport();
              assert.ok(
                rows.some((line) => line.includes("Native long list?")),
                "The question is on screen",
              );
              assert.ok(
                rows.some((line) => line.includes(">") && line.includes(choice)),
                `${choice} is selected on screen`,
              );
            };
            try {
              await nextRender();
              assertVisible("Native choice 01");
              ui.setWidget(
                "native-below",
                Array.from({ length: 4 }, (_, index) => `Below ${index}`),
                { placement: "belowEditor" },
              );
              await nextRender();
              assertVisible("Native choice 01");
              terminal.resize(15);
              await nextRender();
              assertVisible("Native choice 01");
              terminal.resize(24);
              for (let index = 0; index < 29; index += 1) {
                terminal.send("\x1b[B");
              }
              await nextRender();
              assertVisible("Native choice 30");
              terminal.send("\r");
              const result = await execution;
              assert.deepEqual(
                askDetails(result).answers.map((answer) => answer.answer),
                ["Native choice 30"],
              );
              assert.equal(ui.getEditorText(), "untouched draft");
              await nextRender();
              assert.ok(
                viewport().some((line) => line.includes("footer status")),
                "Footer returns when the question closes",
              );
            } finally {
              controller.abort();
              await execution;
              ui.setWidget("native-below", undefined);
              ui.setStatus("native-test", undefined);
              terminal.resize(40);
            }
          },
        );
      }

      await t.test(
        "fullscreen keeps the selected choice visible above a tall below-editor widget",
        async () => {
          ui.setWidget(
            "native-below",
            Array.from({ length: 8 }, (_, index) => `Below ${index}`),
            { placement: "belowEditor" },
          );
          terminal.resize(24);
          assert.equal(switchMode("fullscreen"), true);
          const controller = new AbortController();
          const options = Array.from(
            { length: 30 },
            (_, index) => `Fullscreen choice ${String(index + 1).padStart(2, "0")}`,
          );
          const execution = tool.execute(
            "native-fullscreen-list",
            { question: "Fullscreen choices?", options },
            controller.signal,
          );
          try {
            await nextRender();
            assert.ok(viewport().some((line) => line.includes("Fullscreen choices?")));
            assert.ok(
              viewport().some(
                (line) => line.includes(">") && line.includes("Fullscreen choice 01"),
              ),
            );
            for (let index = 0; index < 29; index += 1) {
              terminal.send("\x1b[B");
            }
            await nextRender();
            assert.ok(
              viewport().some(
                (line) => line.includes(">") && line.includes("Fullscreen choice 30"),
              ),
            );
            terminal.send("\r");
            const result = await execution;
            assert.equal(answerAt(askDetails(result), 0).answer, "Fullscreen choice 30");
          } finally {
            controller.abort();
            await execution;
            switchMode("regular");
            ui.setWidget("native-below", undefined);
            terminal.resize(40);
          }
        },
      );

      await t.test(
        "many multi-select answers do not push the highlighted choice offscreen",
        async () => {
          terminal.resize(24);
          const controller = new AbortController();
          const options = Array.from(
            { length: 30 },
            (_, index) =>
              `Choice ${String(index + 1).padStart(2, "0")} ${"details ".repeat(12)}end-${index + 1}`,
          );
          const execution = tool.execute(
            "native-many-selections",
            { question: "Select several?", options, multiSelect: true },
            controller.signal,
          );
          try {
            await nextRender();
            for (let index = 0; index < 20; index += 1) {
              terminal.send(" ");
              terminal.send("\x1b[B");
            }
            await nextRender();
            assert.ok(
              viewport().some((line) => line.includes("Select several?")),
              "Question stays on screen",
            );
            assert.ok(
              viewport().some((line) => line.includes(">") && line.includes("Choice 21")),
              "Highlighted choice stays on screen",
            );
            assert.ok(
              viewport().some((line) => line.includes("Current answer:") && line.includes("…")),
              "Selected answers still have a compact preview",
            );
            for (let index = 0; index < 10; index += 1) {
              terminal.send("\x1b[B");
            }
            terminal.send("\r");
            terminal.send("SPECIAL-CUSTOM");
            terminal.send("\r");
            await nextRender();
            assert.ok(
              viewport().some(
                (line) => line.includes("Current answer:") && line.includes("SPECIAL-CUSTOM"),
              ),
              "Saved custom choice stays identifiable",
            );
            terminal.send("\x1b[C");
            terminal.send("\r");
            const result = await execution;
            assert.equal(
              answerAt(askDetails(result), 0).answer,
              `${options.slice(0, 20).join(", ")}, SPECIAL-CUSTOM`,
            );
          } finally {
            controller.abort();
            await execution;
            terminal.resize(40);
          }
        },
      );

      await t.test(
        "a saved long custom answer keeps its choice visible and its review readable",
        async () => {
          terminal.resize(24);
          const controller = new AbortController();
          const answer = `START-MARKER ${"word ".repeat(400)}END-MARKER`;
          const execution = tool.execute(
            "native-revisit",
            {
              questions: [
                { question: "First question?", options: ["Recommended"] },
                { question: "Second question?", options: ["Yes"] },
              ],
            },
            controller.signal,
          );
          try {
            await nextRender();
            terminal.send("\x1b[B");
            terminal.send("\r");
            terminal.send(answer);
            terminal.send("\r");
            terminal.send("\x1b[D");
            await nextRender();
            assert.ok(
              viewport().some((line) => line.includes("First question?")),
              "Question remains visible after a long saved answer",
            );
            assert.ok(
              viewport().some((line) => line.includes(">") && line.includes("Recommended")),
              "Current highlighted choice remains visible",
            );
            assert.ok(
              viewport().some((line) => line.includes("Current answer:") && line.includes("…")),
              "Saved answer is previewed on one line",
            );
            assert.ok(
              viewport().some((line) => line.includes("No time limit while you answer.")),
              "Help remains visible after revisiting",
            );

            terminal.send("\x1b[C");
            terminal.send("\r");
            await nextRender();
            assert.ok(
              viewport().some((line) => line.includes("question_2: Yes")),
              "Review shows the last answer",
            );
            assert.ok(
              viewport().some((line) => line.includes("to submit")),
              "Review shows the submission action",
            );
            for (
              let index = 0;
              index < 10 && !viewport().some((line) => line.includes("START-MARKER"));
              index += 1
            ) {
              terminal.send("\x1b[5~");
              await nextRender();
            }
            assert.ok(
              viewport().some((line) => line.includes("START-MARKER")),
              "PageUp reveals the beginning of a long reviewed answer",
            );
            for (
              let index = 0;
              index < 10 && !viewport().some((line) => line.includes("to submit"));
              index += 1
            ) {
              terminal.send("\x1b[6~");
              await nextRender();
            }
            assert.ok(
              viewport().some((line) => line.includes("to submit")),
              "PageDown returns to the submission action",
            );
            terminal.send("\r");
            const result = await execution;
            assert.deepEqual(
              askDetails(result).answers.map((entry) => entry.answer),
              [answer.trim(), "Yes"],
            );
          } finally {
            controller.abort();
            await execution;
            terminal.resize(40);
          }
        },
      );

      await t.test("custom editing stays readable on a 15-row terminal", async () => {
        ui.setEditorText("untouched draft");
        terminal.resize(15);
        const controller = new AbortController();
        const options = Array.from({ length: 30 }, (_, index) => `Choice ${index + 1}`);
        const execution = tool.execute(
          "native-short-edit",
          { question: "Custom details?", options, multiSelect: true },
          controller.signal,
        );
        const answer = `${"word ".repeat(250)}EDIT-END-MARKER`;
        try {
          await nextRender();
          for (let index = 0; index < 30; index += 1) {
            terminal.send("\x1b[B");
          }
          terminal.send("\r");
          terminal.send(answer);
          await nextRender();
          const rows = viewport();
          assert.ok(
            rows.some((line) => line.includes("Custom details?")),
            "Question stays visible while editing",
          );
          assert.ok(
            rows.some((line) => line.includes(">") && line.includes("Type a custom answer")),
            "Selected custom choice stays visible",
          );
          assert.ok(
            rows.some((line) => line.includes("Your answer:")),
            "Editor label stays visible",
          );
          assert.ok(
            rows.some((line) => line.includes("EDIT-END-MARKER")),
            "The editor's active line and caret stay on screen",
          );
          assert.ok(
            rows.some((line) => line.includes("ctrl+o read context")),
            "The context control stays visible",
          );

          terminal.send("\x0f");
          await nextRender();
          assert.ok(viewport().some((line) => line.includes("return to question")));
          terminal.send("\x0f");
          await nextRender();
          assert.ok(
            viewport().some((line) => line.includes("EDIT-END-MARKER")),
            "Reading context preserves the custom answer draft",
          );
          terminal.send("\r");
          terminal.send("\x1b[C");
          terminal.send("\r");
          const result = await execution;
          assert.deepEqual(
            askDetails(result).answers.map((entry) => entry.answer),
            [answer],
          );
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
              `native-long-label-${tuiMode}`,
              { question: "Read the whole choice?", options: [longChoice, "Short choice"] },
              controller.signal,
            );
            try {
              await nextRender();
              assert.ok(viewport().some((line) => line.includes("Read the whole choice?")));
              assert.ok(viewport().some((line) => line.includes("> 1.")));
              assert.ok(
                !viewport().some((line) => line.includes("END-MARKER")),
                "Tail starts below the viewport",
              );

              for (
                let index = 0;
                index < 10 && !viewport().some((line) => line.includes("END-MARKER"));
                index += 1
              ) {
                terminal.send(pageDown);
                await nextRender();
              }
              assert.ok(
                viewport().some((line) => line.includes("END-MARKER")),
                `${tuiMode} PageDown reveals the label tail`,
              );
              for (
                let index = 0;
                index < 10 && !viewport().some((line) => line.includes("> 1."));
                index += 1
              ) {
                terminal.send(pageUp);
                await nextRender();
              }
              assert.ok(
                viewport().some((line) => line.includes("> 1.")),
                `${tuiMode} PageUp returns to the label start`,
              );
              terminal.send("\r");
              const result = await execution;
              assert.equal(answerAt(askDetails(result), 0).answer, longChoice);
            } finally {
              controller.abort();
              await execution;
            }
          }
        } finally {
          if (renderer().mode === "fullscreen") {
            switchMode("regular");
          }
          terminal.resize(40);
        }
      });

      await t.test(
        "a wrapped question can be paged while its selected choice stays visible",
        async () => {
          terminal.resize(15, 40);
          const question = `Which option? ${"context ".repeat(70)}QUESTION-END`;
          const options = Array.from({ length: 30 }, (_, index) => `Choice ${index + 1}`);
          try {
            for (const tuiMode of ["regular", "fullscreen"] as const) {
              assert.equal(switchMode(tuiMode), true);
              const pageDown = tuiMode === "fullscreen" ? "\x1b[6;2~" : "\x1b[6~";
              const pageUp = tuiMode === "fullscreen" ? "\x1b[5;2~" : "\x1b[5~";
              const controller = new AbortController();
              const execution: Promise<{ details: unknown }> = tool.execute(
                `native-long-question-${tuiMode}`,
                { question, options },
                controller.signal,
              );
              try {
                await nextRender();
                assert.ok(viewport().some((line) => line.includes("Which option?")));
                assert.ok(
                  viewport().some((line) => line.includes(">") && line.includes("Choice 1")),
                  "Selected choice is visible",
                );
                assert.ok(
                  !viewport().some((line) => line.includes("QUESTION-END")),
                  "Question tail starts below its page",
                );
                assert.ok(
                  viewport().some((line) => line.includes("pageUp/pageDown")),
                  "Question paging keys are visible",
                );
                for (
                  let index = 0;
                  index < 10 && !viewport().some((line) => line.includes("QUESTION-END"));
                  index += 1
                ) {
                  terminal.send(pageDown);
                  await nextRender();
                  assert.ok(
                    viewport().some((line) => line.includes(">") && line.includes("Choice 1")),
                    "Paging the question keeps the choice visible",
                  );
                }
                assert.ok(
                  viewport().some((line) => line.includes("QUESTION-END")),
                  "PageDown reveals the rest of the question",
                );
                for (
                  let index = 0;
                  index < 10 && !viewport().some((line) => line.includes("Which option?"));
                  index += 1
                ) {
                  terminal.send(pageUp);
                  await nextRender();
                }
                assert.ok(
                  viewport().some((line) => line.includes("Which option?")),
                  "PageUp returns to the question start",
                );
                terminal.send("\r");
                const result = await execution;
                assert.equal(answerAt(askDetails(result), 0).answer, "Choice 1");
              } finally {
                controller.abort();
                await execution;
              }

              const editController = new AbortController();
              const editExecution: Promise<{ details: unknown }> = tool.execute(
                `native-edit-question-${tuiMode}`,
                { question, options },
                editController.signal,
              );
              try {
                await nextRender();
                for (let index = 0; index < 30; index += 1) {
                  terminal.send("\x1b[B");
                }
                terminal.send("\r");
                terminal.send("Draft work");
                await nextRender();
                const firstPage = viewport().find((line) => line.includes("Q 1-"));
                assert.ok(
                  firstPage !== undefined && firstPage.includes("Shift+PageUp"),
                  "The distinct edit-mode question shortcut is visible",
                );
                assert.ok(
                  viewport().some((line) => line.includes("Draft work")),
                  "The custom draft is visible",
                );
                terminal.send("\x1b[6~");
                await nextRender();
                assert.equal(
                  viewport().find((line) => line.includes("Q 1-")),
                  firstPage,
                  "Plain PageDown remains with the editor",
                );
                for (
                  let index = 0;
                  index < 10 && !viewport().some((line) => line.includes("QUESTION-END"));
                  index += 1
                ) {
                  terminal.send("\x1b[6;2~");
                  await nextRender();
                }
                assert.ok(
                  viewport().some((line) => line.includes("QUESTION-END")),
                  "Shift+PageDown reads the question while editing",
                );
                assert.ok(
                  viewport().some((line) => line.includes("Draft work")),
                  "Question paging preserves the custom draft",
                );
                assert.ok(
                  viewport().some(
                    (line) => line.includes(">") && line.includes("Type a custom answer"),
                  ),
                  "The choice stays visible",
                );
                terminal.send("\r");
                const result = await editExecution;
                assert.equal(answerAt(askDetails(result), 0).answer, "Draft work");
              } finally {
                editController.abort();
                await editExecution;
              }
            }
          } finally {
            if (renderer().mode === "fullscreen") {
              switchMode("regular");
            }
            terminal.resize(40, 80);
          }
        },
      );

      await t.test(
        "native reload closes an active cooperative owner and never reuses its reply target",
        async () => {
          const oldStates: BusState[] = [];
          const unsubscribeOld = bus().on("pi-ask-question:state", (data) => {
            assert.ok(isBusState(data));
            oldStates.push(data);
          });
          const execution = tool.execute("remote-reload", { question: "Before reload?" });
          await nextRender();
          const oldTarget = lastOf(oldStates);
          assert.equal(oldTarget.status, "waiting");
          await ctx().reload();
          assert.equal(askDetails(await execution).cancelled, true);
          assert.equal(lastOf(oldStates).status, "closed");
          unsubscribeOld();
          await runtime.session.prompt("/test-ui-context");
          const freshTool = runtime.session.agent.state.tools.find(
            (registered) => registered.name === "ask_question",
          );
          assert.ok(freshTool !== undefined, "Reloaded agent must re-register ask_question");
          const states: BusState[] = [];
          const unsubscribe = bus().on("pi-ask-question:state", (data) => {
            assert.ok(isBusState(data));
            states.push(data);
          });
          const controller = new AbortController();
          const fresh = freshTool.execute(
            "after-reload",
            { question: "After reload?" },
            controller.signal,
          );
          try {
            await nextRender();
            const target = waitingState(states);
            assert.notEqual(target.promptId, oldTarget.promptId);
            assert.notEqual(target.ownerGeneration, oldTarget.ownerGeneration);
            const lookups: LookupResult[] = [];
            const unsubscribeLookup = bus().on("pi-ask-question:lookup-result", (data) => {
              assert.ok(isLookupResult(data));
              lookups.push(data);
            });
            try {
              bus().emit("pi-ask-question:lookup", {
                ...oldTarget,
                queryId: "old-generation",
                requestId: "expired",
              });
              assert.equal(lastOf(lookups).status, "stale");
            } finally {
              unsubscribeLookup();
            }
            bus().emit("pi-ask-question:answer", {
              ...oldTarget,
              requestId: "expired",
              answer: "wrong",
            });
            await nextRender();
            assert.ok(
              viewport().some((line) => line.includes("After reload?")),
              "Stale delivery cannot close the new owner",
            );
            bus().emit("pi-ask-question:answer", {
              ...target,
              requestId: "fresh",
              answer: "fresh answer",
            });
            assert.equal(answerAt(askDetails(await fresh), 0).answer, "fresh answer");
          } finally {
            controller.abort();
            await fresh;
            unsubscribe();
          }
        },
      );

      await t.test(
        "grill-me follows tree, fork, resume and reload on the native runtime",
        async () => {
          await runtime.session.prompt("/grill-me on");
          const enabledEntry = runtime.session.sessionManager.getLeafId();
          assert.ok(enabledEntry !== null, "grill-me status needs a leaf session");
          await runtime.session.prompt("/grill-me off");
          assert.equal(
            (await ctx().navigateTree(enabledEntry, { summarize: false })).cancelled,
            false,
          );
          const assertEnabled = async () => {
            await emitUserBeforeAgentStart(runtime.session.extensionRunner, "test", {
              cwd: home,
              selectedTools: ["ask_question"],
            });
            assert.match(promptAfterLaterExtension, /\/grill-me mode is active/);
          };
          await assertEnabled();

          const outgoing = ctx();
          assert.equal(
            (
              await outgoing.fork(enabledEntry, {
                position: "at",
                withSession: async (fresh) => {
                  fresh.ui.setEditorText("fork draft");
                },
              })
            ).cancelled,
            false,
          );
          assert.throws(() => outgoing.ui.getEditorText(), /stale|invalid|disposed|active/i);
          await runtime.session.prompt("/test-ui-context");
          await assertEnabled();

          // A journal fixture built from the canonical manager is resumed by the real host.
          const journal = join(home, "grill-resume.jsonl");
          const manager = runtime.session.sessionManager;
          writeFileSync(
            journal,
            [manager.getHeader(), ...manager.getBranch()]
              .map((entry) => JSON.stringify(entry))
              .join("\n") + "\n",
          );
          assert.equal((await ctx().switchSession(journal)).cancelled, false);
          await runtime.session.prompt("/test-ui-context");
          await assertEnabled();
          await ctx().reload();
          await runtime.session.prompt("/test-ui-context");
          await assertEnabled();
          await runtime.session.prompt("/grill-me off");
        },
      );
    } finally {
      // Node 24.0 can finish the parent callback before its queued subtests.
      t.after(async () => {
        try {
          await cleanup?.();
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
      });
    }
  },
);
