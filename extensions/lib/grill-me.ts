/** /grill-me mode: command, persisted state, and agent guidance. */

import type {
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { isRecord } from "./validate.ts";

type GrillMeState = {
  enabled: boolean;
};

type GrillMeAction = "toggle" | "enable" | "disable" | "status" | "invalid";

const GRILL_ME_STATE_TYPE = "ask-question.grill-me";
const GRILL_ME_STATUS_KEY = "ask-question.grill-me";
const GRILL_ME_ARGUMENTS = ["on", "off", "status"];

function grillMePrompt(useTool: boolean): string {
  return `IMPORTANT: /grill-me mode is active.

Pressure-test the user's request before doing meaningful work:
- Walk the decision tree: resolve upstream choices before downstream details.
- If a question can be answered by reading local files, docs, tests, or command output, inspect those sources instead of asking the user.
- For non-trivial, risky, underspecified, or strategic requests, ${useTool ? "call ask_question first" : "ask clarifying questions first in normal text"}.
- Ask exactly one blocking question at a time, then wait for the answer before asking the next one.
- For every question, include your recommended answer as the first option and make it specific.
- Do not ask when the next step is obvious, low-risk, or already constrained; proceed normally.
- After the user answers, continue the work directly.`;
}

function parseGrillMeAction(args: string): GrillMeAction {
  switch (args.trim().toLowerCase()) {
    case "":
      return "toggle";
    case "on":
      return "enable";
    case "off":
      return "disable";
    case "status":
      return "status";
    default:
      return "invalid";
  }
}

function completeGrillMeArgs(prefix: string): AutocompleteItem[] | null {
  const matches = GRILL_ME_ARGUMENTS.filter((arg) => arg.startsWith(prefix.trim().toLowerCase()));
  return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
}

function isGrillMeState(data: unknown): data is GrillMeState {
  return (
    data !== null &&
    typeof data === "object" &&
    "enabled" in data &&
    typeof data.enabled === "boolean"
  );
}

function restoreGrillMeState(entries: Iterable<unknown>): boolean {
  let enabled = false;
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    if (
      entry.type === "custom" &&
      entry.customType === GRILL_ME_STATE_TYPE &&
      isGrillMeState(entry.data)
    ) {
      enabled = entry.data.enabled;
    }
  }
  return enabled;
}

/** Register the /grill-me command and its session-aware guidance hooks. */
export function registerGrillMe(pi: ExtensionAPI): void {
  let grillMeMode = false;

  function persistGrillMeMode(): void {
    pi.appendEntry<GrillMeState>(GRILL_ME_STATE_TYPE, { enabled: grillMeMode });
  }

  function updateGrillMeStatus(ctx: Pick<ExtensionContext, "mode" | "ui">): void {
    if (ctx.mode !== "tui") {
      return;
    }
    ctx.ui.setStatus(
      GRILL_ME_STATUS_KEY,
      grillMeMode ? ctx.ui.theme.fg("dim", "grill-mode") : undefined,
    );
  }

  function restoreGrillMeMode(ctx: ExtensionContext): void {
    grillMeMode = restoreGrillMeState(ctx.sessionManager.getBranch());
  }

  pi.registerCommand("grill-me", {
    description: "Toggle a mode that makes the agent pressure-test requests with ask_question",
    getArgumentCompletions: completeGrillMeArgs,
    handler: async (args, ctx): Promise<void> => {
      const action = parseGrillMeAction(args);
      if (action === "enable") {
        grillMeMode = true;
      } else if (action === "disable") {
        grillMeMode = false;
      } else if (action === "toggle") {
        grillMeMode = !grillMeMode;
      } else if (action === "invalid") {
        ctx.ui.notify("Usage: /grill-me [on|off|status]", "warning");
        return;
      }

      if (action !== "status") {
        persistGrillMeMode();
      }
      updateGrillMeStatus(ctx);
      ctx.ui.notify(`Grill-me mode ${grillMeMode ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx): Promise<void> => {
    restoreGrillMeMode(ctx);
    updateGrillMeStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx): Promise<void> => {
    restoreGrillMeMode(ctx);
    updateGrillMeStatus(ctx);
  });

  pi.on(
    "before_agent_start",
    async (event, ctx): Promise<BeforeAgentStartEventResult | undefined> => {
      if (!grillMeMode) {
        return;
      }
      const useTool = ctx.hasUI && pi.getActiveTools().includes("ask_question");
      const guidance = grillMePrompt(useTool);
      if (event.systemPromptOptions.forceSystemPrompt === undefined) {
        // oxlint-disable-next-line eslint/no-param-reassign -- QX-002: Pi documents systemPromptOptions.sections as mutable by handlers; mutation is the supported section-injection contract.
        event.systemPromptOptions.sections.grill_me = guidance;
        return;
      }
      return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
    },
  );
}
