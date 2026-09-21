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
  start(onInput: (data: string) => void, _onResize: () => void) { this.onInput = onInput; }
  stop() { this.onInput = undefined; }
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
}

const nextRender = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

test("native ask UI answers and cancels without consuming the main editor draft", { timeout: 20_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-ask-native-"));
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Keep all imports and host initialization inside the isolated profile.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network in native UI test"); });
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const pi = await import("@earendil-works/pi-coding-agent");
    let commandContext: ExtensionCommandContext | undefined;
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
          extensionFactories: [(api) => api.registerCommand("test-ui-context", {
            handler: async (_args, ctx) => { commandContext = ctx; },
          })],
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
