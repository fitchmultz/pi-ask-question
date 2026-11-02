/** Dialog-mode ask flow for RPC UIs. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clean, orderedAnswers, uniqueOptionLabel } from "./normalize.ts";
import {
  CUSTOM_OPTION,
  DONE_OPTION,
  type Answer,
  type NormalizedQuestion,
  type QuestionResult,
  type QuestionTimeout,
} from "./types.ts";

type DialogContext = {
  ui: ExtensionContext["ui"];
  timeout: QuestionTimeout;
  signal: AbortSignal | undefined;
};

type DialogMenu = {
  options: string[];
  choices: string[];
  customOption: string;
  doneOption: string;
};

type DialogAnswer =
  | { status: "retry" }
  | { status: "cancel" }
  | { status: "picked"; answer: string; wasCustom: boolean };

/** Ask one question set through sequential select/input dialogs. */
export async function askWithDialogs(
  questions: NormalizedQuestion[],
  ui: ExtensionContext["ui"],
  timeout: QuestionTimeout,
  signal: AbortSignal | undefined,
): Promise<QuestionResult> {
  const answers = new Map<string, Answer>();
  for (const question of questions) {
    if (signal?.aborted === true) {
      return { answers: orderedAnswers(questions, answers), cancelled: true };
    }
    const cancelled = await askOneByDialog(question, answers, { ui, timeout, signal });
    if (cancelled) {
      return { answers: orderedAnswers(questions, answers), cancelled: true };
    }
  }
  return { answers: orderedAnswers(questions, answers), cancelled: false };
}

async function askOneByDialog(
  question: NormalizedQuestion,
  answers: Map<string, Answer>,
  context: DialogContext,
): Promise<boolean> {
  const selected: string[] = [];

  while (true) {
    const menu = buildDialogMenu(question, selected);
    const choice = await context.ui.select(
      question.question,
      menu.choices,
      ...(context.signal ? [{ signal: context.signal }] : []),
    );
    if (choice === undefined) {
      return true;
    }
    context.timeout.stop();
    if (choice === menu.doneOption) {
      return false;
    }

    const resolved = await resolveDialogAnswer(question, menu, choice, context);
    if (resolved.status === "cancel") {
      return true;
    }
    if (resolved.status === "retry") {
      continue;
    }
    applyDialogSelection(question, answers, selected, resolved);
    if (!question.multiSelect) {
      return false;
    }
  }
}

function buildDialogMenu(question: NormalizedQuestion, selected: string[]): DialogMenu {
  const customOption = uniqueOptionLabel(CUSTOM_OPTION, question.options);
  const doneOption = uniqueOptionLabel(DONE_OPTION, question.options);
  const options = [
    ...question.options,
    ...selected.filter((answer) => !question.options.includes(answer)),
  ];
  const labels = question.multiSelect
    ? options.map((answer) => `${selected.includes(answer) ? "☑" : "☐"} ${answer}`)
    : options;
  const choices = [...labels, customOption];
  if (question.multiSelect && selected.length > 0) {
    choices.push(doneOption);
  }
  return { options, choices, customOption, doneOption };
}

async function resolveDialogAnswer(
  question: NormalizedQuestion,
  menu: DialogMenu,
  choice: string,
  context: DialogContext,
): Promise<DialogAnswer> {
  if (choice !== menu.customOption) {
    const answer = menu.options[menu.choices.indexOf(choice)] ?? choice;
    return { status: "picked", answer, wasCustom: false };
  }
  const input = await context.ui.input(
    question.question,
    "Type your answer",
    ...(context.signal ? [{ signal: context.signal }] : []),
  );
  if (input === undefined) {
    return { status: "cancel" };
  }
  const custom = clean(input);
  if (custom === undefined) {
    return { status: "retry" };
  }
  return { status: "picked", answer: custom, wasCustom: true };
}

function applyDialogSelection(
  question: NormalizedQuestion,
  answers: Map<string, Answer>,
  selected: string[],
  picked: { answer: string; wasCustom: boolean },
): void {
  const index = selected.indexOf(picked.answer);
  if (question.multiSelect && !picked.wasCustom && index !== -1) {
    selected.splice(index, 1);
  } else if (index === -1) {
    selected.push(picked.answer);
  }
  if (selected.length === 0) {
    answers.delete(question.id);
    return;
  }
  answers.set(question.id, {
    id: question.id,
    question: question.question,
    answer: question.multiSelect ? selected.join(", ") : picked.answer,
    ...(question.multiSelect ? { selectedOptions: [...selected] } : {}),
    wasCustom: question.multiSelect
      ? selected.some((answer) => !question.options.includes(answer))
      : picked.wasCustom,
  });
}
