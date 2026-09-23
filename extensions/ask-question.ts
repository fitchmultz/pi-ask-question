import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, Key, matchesKey, sliceByColumn, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type AutocompleteItem, type Keybinding } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Question = {
  id?: string;
  question: string;
  options?: string[];
  multiSelect?: boolean;
};

type NormalizedQuestion = {
  id: string;
  question: string;
  options: string[];
  multiSelect: boolean;
};

type Answer = {
  id: string;
  question: string;
  answer: string;
  selectedOptions?: string[];
  wasCustom: boolean;
};

type AskQuestionDetails = {
  questions: NormalizedQuestion[];
  answers: Answer[];
  cancelled: boolean;
  timedOut: boolean;
};

type GrillMeState = {
  enabled: boolean;
};

type GrillMeAction = "toggle" | "enable" | "disable" | "status" | "invalid";

const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
const TIMEOUT_MESSAGE = "Mitch is currently AFK. Use your best judgement to choose the option Mitch would choose.";
const CUSTOM_OPTION = "Type a custom answer";
const DONE_OPTION = "Done selecting";
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

const QuestionSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ description: "Stable answer id. Defaults to question_<n>; duplicates are auto-suffixed." })),
    question: Type.String({ minLength: 1, description: "Question to ask the user." }),
    options: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Choices, ordered from most recommended to least recommended." })),
    multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting more than one option for this question. Defaults to false." })),
  },
  { additionalProperties: false },
);

const AskQuestionParams = Type.Object(
  {
    question: Type.Optional(Type.String({ minLength: 1, description: "Single question to ask." })),
    options: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Choices, ordered from most recommended to least recommended." })),
    multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting more than one option for the single question. Defaults to false." })),
    questions: Type.Optional(Type.Array(QuestionSchema, { description: "Ask several questions in order. When provided, takes precedence over the single-question fields." })),
  },
  { additionalProperties: false },
);

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function uniqueOptionLabel(label: string, options: string[]): string {
  let result = label;
  for (let suffix = 2; options.includes(result); suffix += 1) result = `${label} (${suffix})`;
  return result;
}

export function normalize(params: { question?: string; options?: string[]; multiSelect?: boolean; questions?: Question[] }): NormalizedQuestion[] {
  const raw = params.questions?.length
    ? params.questions
    : [{ id: "question_1", question: params.question ?? "", options: params.options, multiSelect: params.multiSelect }];

  const assigned = new Set<string>();
  const result: NormalizedQuestion[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const question = raw[index];
    const text = clean(question.question);
    if (!text) continue;

    const baseId = clean(question.id) ?? `question_${index + 1}`;
    let id = baseId;
    let suffix = 2;
    while (assigned.has(id)) {
      id = `${baseId}_${suffix}`;
      suffix += 1;
    }
    assigned.add(id);

    result.push({
      id,
      question: text,
      options: (question.options ?? [])
        .map(clean)
        .filter((option): option is string => Boolean(option)),
      multiSelect: question.multiSelect === true,
    });
  }

  return result;
}

function orderedAnswers(questions: NormalizedQuestion[], answers: Map<string, Answer>): Answer[] {
  return questions.map((question) => answers.get(question.id)).filter((answer): answer is Answer => Boolean(answer));
}

function formatAnswer(answer?: Answer): string {
  if (!answer) return "unanswered";
  return answer.selectedOptions ? JSON.stringify(answer.selectedOptions) : answer.answer;
}

// Word wrapping drops spaces at line breaks; JSON answer text must keep them.
function wrapByColumn(text: string, width: number): string[] {
  const lines: string[] = [];
  while (visibleWidth(text) > width) {
    const part = sliceByColumn(text, 0, width, true) || sliceByColumn(text, 0, width);
    lines.push(part);
    text = text.slice(part.length);
  }
  return [...lines, text];
}

function exactText(text: string) {
  return {
    render(width: number) {
      const wrapped = text.split("\n").flatMap((line) => wrapByColumn(line, width)).join("\n");
      return new Text(wrapped, 0, 0).render(width);
    },
    invalidate() {},
  };
}

function summarize(questions: NormalizedQuestion[], answers: Map<string, Answer>, cancelled: boolean, timedOut: boolean): string {
  if (timedOut) return [
    `Timed out after 5 minutes. ${TIMEOUT_MESSAGE}`,
    ...(answers.size ? ["", "Answers already provided:", ...orderedAnswers(questions, answers).map((answer) => `- ${answer.id}: ${formatAnswer(answer)}`)] : []),
  ].join("\n");
  if (cancelled) return "User cancelled the question.";
  if (questions.length === 1) return `User answered: ${formatAnswer(answers.get(questions[0].id))}`;
  return [
    "User answered:",
    ...questions.map((question) => `- ${question.id}: ${formatAnswer(answers.get(question.id))}`),
  ].join("\n");
}

async function askWithKeyboard(
  questions: NormalizedQuestion[],
  ui: ExtensionContext["ui"],
  signal?: AbortSignal,
): Promise<{ answers: Answer[]; cancelled: boolean }> {
  if (signal?.aborted) return { answers: [], cancelled: true };
  return ui.custom<{ answers: Answer[]; cancelled: boolean }>((tui, theme, keys, done) => {
    const answers = new Map<string, Answer>();
    const multiAnswers = new Map<string, Set<string>>();
    const customAnswers = new Map<string, string>();
    const keyText = (binding: Keybinding) => keys.getKeys(binding).join("/");
    const editor = new Editor(tui, {
      borderColor: (text) => theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    });

    let tab = 0;
    let option = 0;
    let editing = false;
    let cachedWidth: number | undefined;
    let cachedHeight: number | undefined;
    let cachedLines: string[] | undefined;
    let optionScroll = 0;
    let labelScroll = 0;
    let pageRows = 0;
    let maxLabelScroll = 0;
    let questionScroll = 0;
    let questionPageRows = 0;
    let maxQuestionScroll = 0;
    let reviewScroll: number | undefined;
    let reviewPageRows = 0;
    let maxReviewScroll = 0;

    const submitTab = questions.length;
    const showTabs = questions.length > 1 || questions.some((question) => question.multiSelect);
    const current = () => questions[tab];
    const customOption = () => uniqueOptionLabel(CUSTOM_OPTION, current()?.options ?? []);
    const choices = () => [...(current()?.options ?? []), customOption()];
    const allAnswered = () => questions.every((question) => answers.has(question.id));
    const refresh = () => {
      cachedLines = undefined;
      tui.requestRender();
    };
    let finished = false;
    const finish = (cancelled: boolean) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      done({ answers: orderedAnswers(questions, answers), cancelled });
    };
    const abort = () => finish(true);
    signal?.addEventListener("abort", abort, { once: true });

    function moveTab(next: number) {
      tab = (next + questions.length + 1) % (questions.length + 1);
      option = 0;
      optionScroll = 0;
      labelScroll = 0;
      questionScroll = 0;
      reviewScroll = undefined;
      editing = false;
      editor.setText("");
      refresh();
    }

    function selectedSet(question: NormalizedQuestion): Set<string> {
      let selected = multiAnswers.get(question.id);
      if (!selected) {
        selected = new Set<string>();
        multiAnswers.set(question.id, selected);
      }
      return selected;
    }

    function syncMultiAnswer(question: NormalizedQuestion) {
      const selected = [...selectedSet(question)];
      if (!selected.length) {
        answers.delete(question.id);
        return;
      }
      answers.set(question.id, {
        id: question.id,
        question: question.question,
        answer: selected.join(", "),
        selectedOptions: selected,
        wasCustom: selected.some((answer) => !question.options.includes(answer)),
      });
    }

    function toggleMultiChoice(question: NormalizedQuestion, choice: string) {
      const selected = selectedSet(question);
      if (selected.has(choice)) selected.delete(choice);
      else selected.add(choice);
      syncMultiAnswer(question);
      labelScroll = 0;
      refresh();
    }

    function startCustomEdit(question: NormalizedQuestion) {
      const currentCustom = question.multiSelect
        ? customAnswers.get(question.id)
        : answers.get(question.id)?.wasCustom ? answers.get(question.id)?.answer : undefined;
      editor.setText(currentCustom ?? "");
      editing = true;
      labelScroll = 0;
      optionScroll = 0;
      questionScroll = 0;
      refresh();
    }

    function saveMultiCustomAnswer(question: NormalizedQuestion, answer: string) {
      const selected = selectedSet(question);
      const previous = customAnswers.get(question.id);
      if (previous) selected.delete(previous);
      customAnswers.set(question.id, answer);
      selected.add(answer);
      syncMultiAnswer(question);
      refresh();
    }

    function moveForwardIfAnswered(question: NormalizedQuestion) {
      if (answers.has(question.id)) moveTab(Math.min(tab + 1, submitTab));
      else refresh();
    }

    function saveSingleAnswer(answer: string, wasCustom: boolean) {
      const question = current();
      if (!question) return;
      answers.set(question.id, { id: question.id, question: question.question, answer, wasCustom });
      if (questions.length === 1) finish(false);
      else moveTab(Math.min(tab + 1, submitTab));
    }

    editor.onSubmit = (value) => {
      const answer = clean(value);
      const question = current();
      editing = false;
      editor.setText("");
      if (!answer || !question) {
        refresh();
        return;
      }
      if (question.multiSelect) saveMultiCustomAnswer(question, answer);
      else saveSingleAnswer(answer, true);
    };

    function handleInput(data: string) {
      if (editing) {
        if (maxQuestionScroll && matchesKey(data, Key.shift("pageUp"))) {
          questionScroll = Math.max(0, questionScroll - Math.max(1, questionPageRows - 1));
          refresh();
          return;
        }
        if (maxQuestionScroll && matchesKey(data, Key.shift("pageDown"))) {
          questionScroll = Math.min(maxQuestionScroll, questionScroll + Math.max(1, questionPageRows - 1));
          refresh();
          return;
        }
        if (keys.matches(data, "tui.select.cancel")) {
          editing = false;
          editor.setText("");
          refresh();
          return;
        }
        editor.handleInput(data);
        refresh();
        return;
      }

      if (showTabs && (matchesKey(data, Key.right) || keys.matches(data, "tui.input.tab"))) return moveTab(tab + 1);
      if (showTabs && (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")))) return moveTab(tab - 1);
      if (keys.matches(data, "tui.select.cancel")) return finish(true);
      // Older fullscreen Pi reserves plain Page keys for transcript scrolling.
      const pageUp = keys.matches(data, "tui.select.pageUp") || matchesKey(data, Key.shift("pageUp"));
      const pageDown = keys.matches(data, "tui.select.pageDown") || matchesKey(data, Key.shift("pageDown"));

      if (tab === submitTab) {
        if (maxReviewScroll && pageUp) {
          reviewScroll = Math.max(0, (reviewScroll ?? maxReviewScroll) - Math.max(1, reviewPageRows - 1));
          refresh();
          return;
        }
        if (maxReviewScroll && pageDown) {
          reviewScroll = Math.min(maxReviewScroll, (reviewScroll ?? maxReviewScroll) + Math.max(1, reviewPageRows - 1));
          refresh();
          return;
        }
        if (keys.matches(data, "tui.select.confirm") && allAnswered()) finish(false);
        return;
      }

      const question = current();
      const options = choices();
      if ((maxQuestionScroll || maxLabelScroll) && pageUp) {
        if (labelScroll > 0) labelScroll = Math.max(0, labelScroll - Math.max(1, pageRows - 1));
        else questionScroll = Math.max(0, questionScroll - Math.max(1, questionPageRows - 1));
        refresh();
        return;
      }
      if ((maxQuestionScroll || maxLabelScroll) && pageDown) {
        if (questionScroll < maxQuestionScroll) questionScroll = Math.min(maxQuestionScroll, questionScroll + Math.max(1, questionPageRows - 1));
        else labelScroll = Math.min(maxLabelScroll, labelScroll + Math.max(1, pageRows - 1));
        refresh();
        return;
      }
      if (keys.matches(data, "tui.select.up")) {
        option = Math.max(0, option - 1);
        labelScroll = 0;
        refresh();
        return;
      }
      if (keys.matches(data, "tui.select.down")) {
        option = Math.min(options.length - 1, option + 1);
        labelScroll = 0;
        refresh();
        return;
      }
      if (question.multiSelect && matchesKey(data, Key.space)) {
        const picked = options[option];
        if (picked === customOption()) startCustomEdit(question);
        else if (picked) toggleMultiChoice(question, picked);
        return;
      }
      if (keys.matches(data, "tui.select.confirm")) {
        const picked = options[option];
        if (picked === customOption()) {
          startCustomEdit(question);
        } else if (picked && question.multiSelect) {
          moveForwardIfAnswered(question);
        } else if (picked) {
          saveSingleAnswer(picked, false);
        }
      }
    }

    function render(width: number): string[] {
      const height = tui.terminal.rows;
      if (cachedLines && cachedWidth === width && cachedHeight === height) return cachedLines;
      if (cachedWidth !== width) {
        optionScroll = 0;
        labelScroll = 0;
        questionScroll = 0;
      }
      const lines: string[] = [];
      let questionStart = 0;
      let questionEnd = 0;
      let optionStart = 0;
      let optionEnd = 0;
      let reviewStart = 0;
      let reviewEnd = 0;
      const optionRows: Array<{ start: number; end: number }> = [];
      const add = (line = "") => lines.push(visibleWidth(line) > width ? sliceByColumn(line, 0, width, true) : line);
      const addWrapped = (
        text: string,
        options: { firstPrefix?: string; restPrefix?: string; style?: (text: string) => string; prefixStyle?: (text: string) => string; preserveWhitespace?: boolean } = {},
      ) => {
        const firstPrefix = options.firstPrefix ?? "";
        const restPrefix = options.restPrefix ?? "";
        const style = options.style ?? ((value: string) => value);
        const prefixStyle = options.prefixStyle ?? ((value: string) => value);
        const wrap = options.preserveWhitespace ? wrapByColumn : wrapTextWithAnsi;
        const prefixWidth = visibleWidth(firstPrefix);
        if (prefixWidth >= width || (options.preserveWhitespace && width - prefixWidth < 2)) {
          for (const line of wrap(`${prefixStyle(firstPrefix)}${style(text)}`, width)) add(line);
          return;
        }
        const wrapped = wrap(style(text), width - prefixWidth);
        add(`${prefixStyle(firstPrefix)}${wrapped[0] ?? ""}`);
        for (let index = 1; index < wrapped.length; index += 1) add(`${prefixStyle(restPrefix)}${wrapped[index]}`);
      };
      const border = theme.fg("accent", "─".repeat(width));

      add(border);
      if (showTabs && !editing) {
        addWrapped(
          [
            ...questions.map((question, index) => {
              const marker = answers.has(question.id) ? "■" : "□";
              const label = ` ${marker} Q${index + 1} `;
              return index === tab ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg("muted", label);
            }),
            tab === submitTab ? theme.bg("selectedBg", theme.fg("text", " Submit ")) : theme.fg(allAnswered() ? "success" : "dim", " Submit "),
          ].join(" "),
        );
        add();
      }

      if (tab === submitTab) {
        addWrapped(theme.bold("Review answers"));
        add();
        reviewStart = lines.length;
        for (const question of questions) {
          const answer = answers.get(question.id);
          addWrapped(formatAnswer(answer), {
            firstPrefix: `${question.id}: `,
            restPrefix: " ".repeat(visibleWidth(`${question.id}: `)),
            style: answer ? undefined : (text) => theme.fg("warning", text),
            preserveWhitespace: Boolean(answer?.selectedOptions),
          });
        }
        reviewEnd = lines.length;
        add();
        addWrapped(allAnswered() ? `${keyText("tui.select.confirm")} to submit` : "Answer all questions before submitting", {
          style: (text) => theme.fg(allAnswered() ? "success" : "warning", text),
        });
      } else {
        const question = current();
        const options = choices();
        const answer = answers.get(question.id);
        const selected = question.multiSelect ? selectedSet(question) : undefined;
        questionStart = lines.length;
        addWrapped(question.multiSelect ? `${question.question} (select one or more)` : question.question);
        questionEnd = lines.length;
        add();
        optionStart = lines.length;
        options.forEach((choice, index) => {
          if (editing && index !== option) return;
          const start = lines.length - optionStart;
          const highlighted = index === option;
          const checked = selected?.has(choice) ?? false;
          const marker = question.multiSelect ? (choice === customOption() ? "✎" : checked ? "☑" : "☐") : `${index + 1}.`;
          const prefix = `${highlighted ? ">" : " "} ${marker} `;
          addWrapped(choice, {
            firstPrefix: prefix,
            restPrefix: " ".repeat(prefix.length),
            style: (text) => theme.fg(highlighted ? "accent" : "text", text),
            prefixStyle: (text) => highlighted && text.includes(">") ? theme.fg("accent", text) : text,
          });
          optionRows.push({ start, end: lines.length - optionStart });
        });
        optionEnd = lines.length;
        if (answer && !editing) {
          const custom = question.multiSelect ? customAnswers.get(question.id) : undefined;
          const summary = custom && selected?.has(custom) ? `${custom} (${selected.size} selected)` : answer.answer;
          const preview = `Current answer: ${summary.replace(/\s+/g, " ")}`;
          add(theme.fg("muted", truncateToWidth(preview, width, "…")));
        }
        if (editing) {
          addWrapped(theme.fg("muted", "Your answer:"));
          const indent = width > 1 ? " " : "";
          const editorWidth = Math.max(1, width - visibleWidth(indent));
          for (const line of editor.render(Math.max(3, editorWidth))) {
            const cursorIndex = line.indexOf(CURSOR_MARKER);
            const cursorColumn = cursorIndex === -1 ? 0 : visibleWidth(line.slice(0, cursorIndex));
            const startColumn = Math.max(0, cursorColumn - editorWidth + 1);
            add(`${indent}${sliceByColumn(line, startColumn, editorWidth, true)}`);
          }
        }
      }

      if (!editing) add();
      addWrapped("Auto-continues after 5 minutes with an AFK reply.", { style: (text) => theme.fg("dim", text) });
      addWrapped(
        editing
          ? `${keyText("tui.input.submit")} save answer • ${keyText("tui.select.cancel")} cancel edit`
          : showTabs
            ? `←/→ or ${keyText("tui.input.tab")} questions • ${keyText("tui.select.up")}/${keyText("tui.select.down")} options • Space toggle multi-select • ${keyText("tui.select.confirm")} next/submit • ${keyText("tui.select.cancel")} cancel`
            : `${keyText("tui.select.up")}/${keyText("tui.select.down")} options • ${keyText("tui.select.confirm")} select • ${keyText("tui.select.cancel")} cancel`,
        { style: (text) => theme.fg("dim", text) },
      );
      add(border);

      if (tab !== submitTab) {
        const questionLines = lines.slice(questionStart, questionEnd);
        const selectedRow = editing ? 0 : option;
        const selectedHeight = optionRows[selectedRow].end - optionRows[selectedRow].start;
        const room = Math.max(2, height - (lines.length - questionLines.length - (optionEnd - optionStart)));
        const questionRows = Math.max(1, room - selectedHeight);
        maxQuestionScroll = Math.max(0, questionLines.length - questionRows);
        questionScroll = Math.min(questionScroll, maxQuestionScroll);
        questionPageRows = questionRows;
        if (maxQuestionScroll) {
          lines.splice(questionStart, questionLines.length, ...questionLines.slice(questionScroll, questionScroll + questionRows));
          const removed = questionLines.length - questionRows;
          optionStart -= removed;
          optionEnd -= removed;
        }

        const optionLines = lines.slice(optionStart, optionEnd);
        const available = Math.max(1, height);
        const visibleOptions = Math.max(1, available - (lines.length - optionLines.length));
        let optionStatus = "";
        if (optionLines.length > visibleOptions) {
          // Scroll at choice boundaries so labels that fit are shown in full.
          optionScroll = Math.min(optionScroll, selectedRow);
          while (optionScroll < selectedRow && optionRows[selectedRow].end - optionRows[optionScroll].start > visibleOptions) optionScroll++;
          let end = selectedRow + 1;
          while (end < optionRows.length && optionRows[end].end - optionRows[optionScroll].start <= visibleOptions) end++;
          while (optionScroll > 0 && optionRows[end - 1].end - optionRows[optionScroll - 1].start <= visibleOptions) optionScroll--;
          maxLabelScroll = Math.max(0, optionRows[selectedRow].end - optionRows[selectedRow].start - visibleOptions);
          labelScroll = Math.min(labelScroll, maxLabelScroll);
          pageRows = visibleOptions;
          const startLine = optionRows[optionScroll].start + labelScroll;
          const endLine = Math.min(optionRows[end - 1].end, startLine + visibleOptions);
          const above = optionScroll > 0 || labelScroll > 0 ? "↑ " : "";
          const below = endLine < optionLines.length ? " ↓" : "";
          optionStatus = `${above}${option + 1}/${choices().length}${below}`;
          lines.splice(optionStart, optionLines.length, ...optionLines.slice(startLine, endLine));
        } else {
          optionScroll = 0;
          labelScroll = 0;
          maxLabelScroll = 0;
        }
        if (maxQuestionScroll || optionStatus) {
          const questionStatus = maxQuestionScroll ? `Q ${questionScroll + 1}-${Math.min(questionScroll + questionRows, questionLines.length)}/${questionLines.length}` : "";
          const read = !editing && (maxQuestionScroll || maxLabelScroll) ? ` • ${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")} read (Shift+Page fullscreen)` : "";
          const status = editing && maxQuestionScroll
            ? `Shift+PageUp/Down question • ${questionStatus}`
            : `${[questionStatus, optionStatus].filter(Boolean).join(" • ")}${read}`;
          lines[optionStart - 1] = sliceByColumn(theme.fg("dim", ` ${status}`), 0, width, true);
        }
      } else {
        const answerLines = lines.slice(reviewStart, reviewEnd);
        const visibleAnswers = Math.max(1, height - (lines.length - answerLines.length));
        const wasAtEnd = reviewScroll === undefined || reviewScroll === maxReviewScroll;
        maxReviewScroll = Math.max(0, answerLines.length - visibleAnswers);
        reviewScroll = wasAtEnd ? maxReviewScroll : Math.min(reviewScroll ?? 0, maxReviewScroll);
        reviewPageRows = visibleAnswers;
        if (maxReviewScroll) {
          const above = reviewScroll > 0 ? "↑ " : "";
          const below = reviewScroll < maxReviewScroll ? " ↓" : "";
          const read = `${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")} read answers (Shift+Page fullscreen)`;
          lines[reviewStart - 1] = sliceByColumn(theme.fg("dim", ` ${above}${read}${below}`), 0, width, true);
          lines.splice(reviewStart, answerLines.length, ...answerLines.slice(reviewScroll, reviewScroll + visibleAnswers));
        }
      }

      cachedWidth = width;
      cachedHeight = height;
      cachedLines = lines;
      return lines;
    }

    return {
      get focused() { return editor.focused; },
      set focused(value: boolean) {
        if (editor.focused === value) return;
        editor.focused = value;
        cachedLines = undefined;
        tui.requestRender();
      },
      render,
      handleInput,
      invalidate: () => { cachedLines = undefined; },
      dispose: () => signal?.removeEventListener("abort", abort),
    };
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-center" } });
}

async function askWithDialogs(
  questions: NormalizedQuestion[],
  ui: ExtensionContext["ui"],
  signal?: AbortSignal,
): Promise<{ answers: Answer[]; cancelled: boolean }> {
  const answers = new Map<string, Answer>();

  for (const question of questions) {
    if (signal?.aborted) return { answers: orderedAnswers(questions, answers), cancelled: true };
    const selected: string[] = [];

    while (true) {
      const options = [...question.options, ...selected.filter((answer) => !question.options.includes(answer))];
      const customOption = uniqueOptionLabel(CUSTOM_OPTION, options);
      const doneOption = uniqueOptionLabel(DONE_OPTION, options);
      const choices = [...options, customOption];
      if (question.multiSelect && selected.length) choices.push(doneOption);
      const title = selected.length
        ? `${question.question}\nSelected: ${JSON.stringify(selected)} (choose again to remove)`
        : question.question;
      const choice = await ui.select(title, choices, { signal });
      if (choice === undefined) return { answers: orderedAnswers(questions, answers), cancelled: true };
      if (choice === doneOption) break;

      let answer = choice;
      let wasCustom = false;
      if (choice === customOption) {
        const input = await ui.input(question.question, "Type your answer", { signal });
        if (input === undefined) return { answers: orderedAnswers(questions, answers), cancelled: true };
        const custom = clean(input);
        if (!custom) continue;
        answer = custom;
        wasCustom = true;
      }

      const index = selected.indexOf(answer);
      if (question.multiSelect && !wasCustom && index !== -1) selected.splice(index, 1);
      else if (index === -1) selected.push(answer);
      if (!selected.length) answers.delete(question.id);
      else answers.set(question.id, {
        id: question.id,
        question: question.question,
        answer: question.multiSelect ? selected.join(", ") : answer,
        ...(question.multiSelect ? { selectedOptions: [...selected] } : {}),
        wasCustom: question.multiSelect ? selected.some((answer) => !question.options.includes(answer)) : wasCustom,
      });
      if (!question.multiSelect) break;
    }
  }

  return { answers: orderedAnswers(questions, answers), cancelled: false };
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
  return matches.length ? matches.map((value) => ({ value, label: value })) : null;
}

function isGrillMeState(data: unknown): data is GrillMeState {
  return data !== null && typeof data === "object" && "enabled" in data && typeof data.enabled === "boolean";
}

function restoreGrillMeState(entries: Iterable<unknown>): boolean {
  let enabled = false;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (record.type === "custom" && record.customType === GRILL_ME_STATE_TYPE && isGrillMeState(record.data)) {
      enabled = record.data.enabled;
    }
  }
  return enabled;
}

const askQuestionTool = defineTool({
  name: "ask_question",
  label: "Ask Question",
  description: "Ask the user one or more clarifying questions through pi's UI. After 5 minutes, returns an AFK reply so you can continue using your best judgement.",
  promptSnippet: "Ask the user clarifying questions through pi's UI",
  promptGuidelines: [
    "For ask_question, list options from most recommended to least; the first option is the recommended choice, and do not label it as recommended.",
    "For ask_question, set multiSelect:true only when the user may need to choose more than one option.",
    "For ask_question, a typed custom-answer option is added automatically; do not include your own.",
  ],
  parameters: AskQuestionParams,
  executionMode: "sequential",

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const questions = normalize(params);
    if (!questions.length) throw new Error("ask_question needs either question or questions[].");
    if (!ctx.hasUI) throw new Error("ask_question needs Pi TUI or RPC UI support.");

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), QUESTION_TIMEOUT_MS);
    const questionSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const result = ctx.mode === "tui"
        ? await askWithKeyboard(questions, ctx.ui, questionSignal)
        : await askWithDialogs(questions, ctx.ui, questionSignal);
      const answers = new Map(result.answers.map((answer) => [answer.id, answer]));
      const timedOut = result.cancelled && timeout.signal.aborted && !signal?.aborted;
      const cancelled = result.cancelled && !timedOut;

      return {
        content: [{ type: "text", text: summarize(questions, answers, cancelled, timedOut) }],
        details: { questions, answers: result.answers, cancelled, timedOut } satisfies AskQuestionDetails,
      };
    } finally {
      clearTimeout(timer);
    }
  },

  renderCall(args, theme, _context) {
    const questions = normalize(args);
    const count = questions.length;
    const labels = questions.map((question) => question.id).join(", ");
    let text = theme.fg("toolTitle", theme.bold("ask_question "));
    text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
    if (labels) text += theme.fg("dim", ` (${labels})`);
    return new Text(text, 0, 0);
  },

  renderResult(result, _options, theme, _context) {
    const details = result.details as AskQuestionDetails | undefined;
    if (!details) {
      const content = result.content[0];
      return new Text(content?.type === "text" ? content.text : "", 0, 0);
    }
    if (details.timedOut) {
      const content = result.content[0];
      const text = theme.fg("warning", content?.type === "text" ? content.text : TIMEOUT_MESSAGE);
      return details.answers.some((answer) => answer.selectedOptions) ? exactText(text) : new Text(text, 0, 0);
    }
    if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
    const lines = details.questions.map((question) => {
      const answer = details.answers.find((entry) => entry.id === question.id);
      return `${theme.fg("success", "✓ ")}${theme.fg("accent", question.id)}: ${formatAnswer(answer)}`;
    });
    const text = lines.join("\n");
    return details.answers.some((answer) => answer.selectedOptions) ? exactText(text) : new Text(text, 0, 0);
  },
});

function registerGrillMe(pi: ExtensionAPI) {
  let grillMeMode = false;

  function persistGrillMeMode() {
    pi.appendEntry<GrillMeState>(GRILL_ME_STATE_TYPE, { enabled: grillMeMode });
  }

  function updateGrillMeStatus(ctx: Pick<ExtensionContext, "mode" | "ui">) {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus(GRILL_ME_STATUS_KEY, grillMeMode ? ctx.ui.theme.fg("dim", "grill-mode") : undefined);
  }

  function restoreGrillMeMode(ctx: ExtensionContext) {
    grillMeMode = restoreGrillMeState(ctx.sessionManager.getBranch());
  }

  pi.registerCommand("grill-me", {
    description: "Toggle a mode that makes the agent pressure-test requests with ask_question",
    getArgumentCompletions: completeGrillMeArgs,
    handler: async (args, ctx) => {
      const action = parseGrillMeAction(args);
      if (action === "enable") grillMeMode = true;
      else if (action === "disable") grillMeMode = false;
      else if (action === "toggle") grillMeMode = !grillMeMode;
      else if (action === "invalid") {
        ctx.ui.notify("Usage: /grill-me [on|off|status]", "warning");
        return;
      }

      if (action !== "status") persistGrillMeMode();
      updateGrillMeStatus(ctx);
      ctx.ui.notify(`Grill-me mode ${grillMeMode ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreGrillMeMode(ctx);
    updateGrillMeStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreGrillMeMode(ctx);
    updateGrillMeStatus(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!grillMeMode) return undefined;
    const useTool = ctx.hasUI && pi.getActiveTools().includes("ask_question");
    return { systemPrompt: `${event.systemPrompt}\n\n${grillMePrompt(useTool)}` };
  });
}

export default function askQuestion(pi: ExtensionAPI) {
  pi.registerTool(askQuestionTool);
  registerGrillMe(pi);
}
