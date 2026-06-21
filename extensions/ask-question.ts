import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey } from "@earendil-works/pi-tui";
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
  wasCustom: boolean;
};

const CUSTOM_OPTION = "Type a custom answer";

const QuestionSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ description: "Stable answer id." })),
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
    questions: Type.Optional(Type.Array(QuestionSchema, { description: "Ask several questions in order." })),
  },
  { additionalProperties: false },
);

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalize(params: { question?: string; options?: string[]; multiSelect?: boolean; questions?: Question[] }): NormalizedQuestion[] {
  const raw = params.questions?.length
    ? params.questions
    : [{ id: "question_1", question: params.question ?? "", options: params.options, multiSelect: params.multiSelect }];

  return raw.flatMap((question, index) => {
    const text = clean(question.question);
    if (!text) return [];
    return [{
      id: clean(question.id) ?? `question_${index + 1}`,
      question: text,
      options: (question.options ?? [])
        .map(clean)
        .filter((option): option is string => Boolean(option) && option !== CUSTOM_OPTION),
      multiSelect: question.multiSelect === true,
    }];
  });
}

function orderedAnswers(questions: NormalizedQuestion[], answers: Map<string, Answer>): Answer[] {
  return questions.map((question) => answers.get(question.id)).filter((answer): answer is Answer => Boolean(answer));
}

function summarize(questions: NormalizedQuestion[], answers: Map<string, Answer>, cancelled: boolean): string {
  if (cancelled) return "User cancelled the question.";
  if (questions.length === 1) return `User answered: ${answers.get(questions[0].id)?.answer ?? "unanswered"}`;
  return [
    "User answered:",
    ...questions.map((question) => `- ${question.id}: ${answers.get(question.id)?.answer ?? "unanswered"}`),
  ].join("\n");
}

function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    if (word.length > safeWidth) {
      if (line) lines.push(line);
      for (let i = 0; i < word.length; i += safeWidth) lines.push(word.slice(i, i + safeWidth));
      line = "";
    } else if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= safeWidth) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

async function askWithKeyboard(questions: NormalizedQuestion[], ui: ExtensionContext["ui"]): Promise<{ answers: Answer[]; cancelled: boolean }> {
  return ui.custom<{ answers: Answer[]; cancelled: boolean }>((tui, theme, _keys, done) => {
    const answers = new Map<string, Answer>();
    const multiAnswers = new Map<string, Set<string>>();
    const customAnswers = new Map<string, string>();
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
    let cachedLines: string[] | undefined;

    const submitTab = questions.length;
    const showTabs = questions.length > 1 || questions.some((question) => question.multiSelect);
    const current = () => questions[tab];
    const choices = () => [...(current()?.options ?? []), CUSTOM_OPTION];
    const allAnswered = () => questions.every((question) => answers.has(question.id));
    const refresh = () => {
      cachedLines = undefined;
      tui.requestRender();
    };
    const finish = (cancelled: boolean) => done({ answers: orderedAnswers(questions, answers), cancelled });

    function moveTab(next: number) {
      tab = (next + questions.length + 1) % (questions.length + 1);
      option = 0;
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
        wasCustom: selected.some((answer) => !question.options.includes(answer)),
      });
    }

    function toggleMultiChoice(question: NormalizedQuestion, choice: string) {
      const selected = selectedSet(question);
      if (selected.has(choice)) selected.delete(choice);
      else selected.add(choice);
      syncMultiAnswer(question);
      refresh();
    }

    function startCustomEdit(question: NormalizedQuestion) {
      const currentCustom = question.multiSelect
        ? customAnswers.get(question.id)
        : answers.get(question.id)?.wasCustom ? answers.get(question.id)?.answer : undefined;
      editor.setText(currentCustom ?? "");
      editing = true;
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
        if (matchesKey(data, Key.escape)) {
          editing = false;
          editor.setText("");
          refresh();
          return;
        }
        editor.handleInput(data);
        refresh();
        return;
      }

      if (showTabs && (matchesKey(data, Key.right) || matchesKey(data, Key.tab))) return moveTab(tab + 1);
      if (showTabs && (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")))) return moveTab(tab - 1);
      if (matchesKey(data, Key.escape)) return finish(true);

      if (tab === submitTab) {
        if (matchesKey(data, Key.enter) && allAnswered()) finish(false);
        return;
      }

      const question = current();
      const options = choices();
      if (matchesKey(data, Key.up)) {
        option = Math.max(0, option - 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        option = Math.min(options.length - 1, option + 1);
        refresh();
        return;
      }
      if (question.multiSelect && matchesKey(data, Key.space)) {
        const picked = options[option];
        if (picked === CUSTOM_OPTION) startCustomEdit(question);
        else if (picked) toggleMultiChoice(question, picked);
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const picked = options[option];
        if (picked === CUSTOM_OPTION) {
          startCustomEdit(question);
        } else if (picked && question.multiSelect) {
          moveForwardIfAnswered(question);
        } else if (picked) {
          saveSingleAnswer(picked, false);
        }
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;
      const lines: string[] = [];
      const add = (line = "") => lines.push(line);
      const addWrapped = (
        text: string,
        options: { firstPrefix?: string; restPrefix?: string; style?: (text: string) => string; prefixStyle?: (text: string) => string } = {},
      ) => {
        const firstPrefix = options.firstPrefix ?? "";
        const restPrefix = options.restPrefix ?? "";
        const style = options.style ?? ((value: string) => value);
        const prefixStyle = options.prefixStyle ?? ((value: string) => value);
        const firstWidth = Math.max(1, width - firstPrefix.length);
        const restWidth = Math.max(1, width - restPrefix.length);
        const [first = "", ...rest] = wrapText(text, firstWidth);
        add(`${prefixStyle(firstPrefix)}${style(first)}`);
        for (const line of rest.flatMap((value) => wrapText(value, restWidth))) add(`${prefixStyle(restPrefix)}${style(line)}`);
      };
      const border = theme.fg("accent", "─".repeat(width));

      add(border);
      if (showTabs) {
        add(
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
        add(theme.bold("Review answers"));
        add();
        for (const question of questions) {
          addWrapped(answers.get(question.id)?.answer ?? "unanswered", {
            firstPrefix: `${question.id}: `,
            restPrefix: " ".repeat(question.id.length + 2),
            style: answers.has(question.id) ? undefined : (text) => theme.fg("warning", text),
          });
        }
        add();
        addWrapped(allAnswered() ? "Enter to submit" : "Answer all questions before submitting", {
          style: (text) => theme.fg(allAnswered() ? "success" : "warning", text),
        });
      } else {
        const question = current();
        const options = choices();
        const answer = answers.get(question.id);
        const selected = question.multiSelect ? selectedSet(question) : undefined;
        addWrapped(question.multiSelect ? `${question.question} (select one or more)` : question.question);
        if (answer) addWrapped(`Current answer: ${answer.answer}`, { style: (text) => theme.fg("muted", text) });
        add();
        options.forEach((choice, index) => {
          const highlighted = index === option;
          const checked = selected?.has(choice) ?? false;
          const marker = question.multiSelect ? (choice === CUSTOM_OPTION ? "✎" : checked ? "☑" : "☐") : `${index + 1}.`;
          const prefix = `${highlighted ? ">" : " "} ${marker} `;
          addWrapped(choice, {
            firstPrefix: prefix,
            restPrefix: " ".repeat(prefix.length),
            style: (text) => theme.fg(highlighted ? "accent" : "text", text),
            prefixStyle: (text) => highlighted && text.includes(">") ? theme.fg("accent", text) : text,
          });
        });
        if (editing) {
          add();
          add(theme.fg("muted", "Your answer:"));
          for (const line of editor.render(width - 2)) add(` ${line}`);
        }
      }

      add();
      addWrapped(
        showTabs
          ? "←/→ questions • ↑/↓ options • Space toggle multi-select • Enter next/submit • Esc cancel"
          : "↑/↓ options • Enter select • Esc cancel",
        { style: (text) => theme.fg("dim", text) },
      );
      add(border);
      cachedLines = lines;
      return lines;
    }

    return { render, handleInput, invalidate: () => { cachedLines = undefined; } };
  });
}

const askQuestionTool = defineTool({
  name: "ask_question",
  label: "Ask Question",
  description: "Ask the user one or more clarifying questions through pi's UI. Works for any model.",
  promptSnippet: "Ask the user clarifying questions through pi's UI",
  promptGuidelines: [
    "When using ask_question, list options from most recommended to least recommended. The first option must be the recommended choice.",
    "Do not label an option as recommended; the option order already communicates recommendation.",
    "Set multiSelect:true only when the user may need to choose more than one option for a question.",
    "ask_question always adds a typed custom-answer option last; do not include your own custom-answer option.",
    "Use as many or as few ask_question options as are useful for the decision.",
    "Use ask_question when user input would materially change scope, requirements, implementation choices, or acceptance criteria.",
  ],
  parameters: AskQuestionParams,

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const questions = normalize(params);
    if (!questions.length) throw new Error("ask_question needs either question or questions[].");
    if (!ctx.hasUI) throw new Error("ask_question needs an interactive pi UI.");

    const result = await askWithKeyboard(questions, ctx.ui);
    const answers = new Map(result.answers.map((answer) => [answer.id, answer]));

    return {
      content: [{ type: "text", text: summarize(questions, answers, result.cancelled) }],
      details: { questions, answers: result.answers, cancelled: result.cancelled },
    };
  },
});

export default function askQuestion(pi: ExtensionAPI) {
  pi.registerTool(askQuestionTool);
}
