/** The ask_question tool definition. */

import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { askWithDialogs } from "./ask-dialogs.ts";
import { askWithKeyboard } from "./ask-keyboard.ts";
import { formatAnswer, normalize, summarize } from "./normalize.ts";
import type { QuestionObserver } from "./question-observer.ts";
import { AskQuestionParams } from "./schema.ts";
import { exactText } from "./text.ts";
import {
  QUESTION_TIMEOUT_MS,
  TIMEOUT_MESSAGE,
  type AskQuestionDetails,
  type QuestionTimeout,
} from "./types.ts";

function createQuestionTimeout(): {
  timeout: QuestionTimeout;
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const deadline = Date.now() + QUESTION_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), QUESTION_TIMEOUT_MS);
  let active = true;
  const timeout: QuestionTimeout = {
    deadline,
    get active() {
      return active;
    },
    stop() {
      if (!active) {
        return false;
      }
      active = false;
      clearTimeout(timer);
      return true;
    },
  };
  return { timeout, signal: controller.signal, dispose: () => clearTimeout(timer) };
}

function renderAskCall(args: Static<typeof AskQuestionParams>, theme: Theme): Component {
  const questions = normalize(args);
  const count = questions.length;
  const labels = questions.map((question) => question.id).join(", ");
  let text = theme.fg("toolTitle", theme.bold("ask_question "));
  text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
  if (labels !== "") {
    text += theme.fg("dim", ` (${labels})`);
  }
  return new Text(text, 0, 0);
}

function renderAskResult(result: AgentToolResult<AskQuestionDetails>, theme: Theme): Component {
  const details = result.details;
  if (details.timedOut) {
    const content = result.content[0];
    const text = theme.fg("warning", content?.type === "text" ? content.text : TIMEOUT_MESSAGE);
    return details.answers.some((answer) => answer.selectedOptions !== undefined)
      ? exactText(text)
      : new Text(text, 0, 0);
  }
  if (details.cancelled) {
    return new Text(theme.fg("warning", "Cancelled"), 0, 0);
  }
  const lines = details.questions.map((question) => {
    const answer = details.answers.find((entry) => entry.id === question.id);
    return `${theme.fg("success", "✓ ")}${theme.fg("accent", question.id)}: ${formatAnswer(answer)}`;
  });
  const text = lines.join("\n");
  return details.answers.some((answer) => answer.selectedOptions !== undefined)
    ? exactText(text)
    : new Text(text, 0, 0);
}

/** Build the registered ask_question tool bound to one observer. */
export function createAskQuestionTool(
  pi: ExtensionAPI,
  observer: QuestionObserver,
): ToolDefinition<typeof AskQuestionParams, AskQuestionDetails> {
  return defineTool<typeof AskQuestionParams, AskQuestionDetails>({
    name: "ask_question",
    label: "Ask Question",
    description:
      "Ask the user one or more clarifying questions through pi's UI. After 5 minutes without interaction, returns an AFK reply so you can continue already-authorized work without treating silence as missing approval.",
    promptSnippet: "Ask the user clarifying questions through pi's UI",
    promptGuidelines: [
      "For ask_question, list options from most recommended to least; the first option is the recommended choice, and do not label it as recommended.",
      "For ask_question, set multiSelect:true only when the user may need to choose more than one option.",
      "For ask_question, a typed custom-answer option is added automatically; do not include your own.",
    ],
    parameters: AskQuestionParams,
    executionMode: "sequential",

    // oxlint-disable-next-line eslint/max-params -- QX-001: defineTool's execute callback signature is fixed by the Pi SDK at five parameters.
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = normalize(params);
      if (questions.length === 0) {
        throw new Error("ask_question needs either question or questions[].");
      }
      if (!ctx.hasUI) {
        throw new Error("ask_question needs Pi TUI or RPC UI support.");
      }

      observer.identify(ctx);
      const { timeout, signal: timeoutSignal, dispose } = createQuestionTimeout();
      const questionSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        const result =
          ctx.mode === "tui"
            ? await askWithKeyboard({
                questions,
                ui: ctx.ui,
                pi,
                observer,
                timeout,
                signal: questionSignal,
              })
            : await askWithDialogs(questions, ctx.ui, timeout, questionSignal);
        const answers = new Map(result.answers.map((answer) => [answer.id, answer]));
        const timedOut = result.cancelled && timeoutSignal.aborted && signal?.aborted !== true;
        const cancelled = result.cancelled && !timedOut;

        return {
          content: [{ type: "text", text: summarize(questions, answers, cancelled, timedOut) }],
          details: {
            questions,
            answers: result.answers,
            cancelled,
            timedOut,
          },
        };
      } finally {
        dispose();
      }
    },

    renderCall: (args, theme, _context) => renderAskCall(args, theme),
    renderResult: (result, _options, theme, _context) => renderAskResult(result, theme),
  });
}
