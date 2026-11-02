/** Page layout for the question form: line accumulation and section bounds. */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Keybinding,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import { formatAnswer } from "./normalize.ts";
import { wrapByColumn } from "./text.ts";
import type { Answer, NormalizedQuestion } from "./types.ts";

/** Read-only form surface the page builders render from. */
export type FormView = {
  readonly questions: NormalizedQuestion[];
  readonly answers: Map<string, Answer>;
  readonly customAnswers: Map<string, string>;
  readonly tab: number;
  readonly option: number;
  readonly editing: boolean;
  readonly showTabs: boolean;
  readonly submitTab: number;
  readonly timeoutActive: boolean;
  readonly theme: Theme;
  keyText: (binding: Keybinding) => string;
  current: () => NormalizedQuestion | undefined;
  choices: () => string[];
  customOption: () => string;
  allAnswered: () => boolean;
  selectedSet: (question: NormalizedQuestion) => Set<string>;
  renderEditor: (width: number) => string[];
};

/** Accumulates rendered lines while tracking page-section bounds. */
export class PageBuilder {
  readonly width: number;
  readonly lines: string[] = [];
  readonly optionRows: Array<{ start: number; end: number }> = [];
  questionStart = 0;
  questionEnd = 0;
  optionStart = 0;
  optionEnd = 0;
  reviewStart = 0;
  reviewEnd = 0;
  contextHint = "";

  constructor(width: number) {
    this.width = width;
  }

  get length(): number {
    return this.lines.length;
  }

  add(line = ""): void {
    this.lines.push(
      visibleWidth(line) > this.width ? sliceByColumn(line, 0, this.width, true) : line,
    );
  }

  beginQuestion(): void {
    this.questionStart = this.lines.length;
  }

  endQuestion(): void {
    this.questionEnd = this.lines.length;
  }

  beginOptions(): void {
    this.optionStart = this.lines.length;
  }

  endOptions(): void {
    this.optionEnd = this.lines.length;
  }

  beginReview(): void {
    this.reviewStart = this.lines.length;
  }

  endReview(): void {
    this.reviewEnd = this.lines.length;
  }

  pushOptionRow(start: number): void {
    this.optionRows.push({ start, end: this.lines.length - this.optionStart });
  }

  setLine(index: number, line: string): void {
    this.lines[index] = line;
  }

  setContextHint(hint: string): void {
    this.contextHint = hint;
  }

  /** Drop clipped rows and shift the option section up by the removed count. */
  shiftOptions(removed: number): void {
    this.optionStart -= removed;
    this.optionEnd -= removed;
  }
}

type WrapOptions = {
  firstPrefix?: string;
  restPrefix?: string;
  style?: (text: string) => string;
  prefixStyle?: (text: string) => string;
  preserveWhitespace?: boolean;
};

type ResolvedWrap = {
  firstPrefix: string;
  restPrefix: string;
  style: (text: string) => string;
  prefixStyle: (text: string) => string;
  preserveWhitespace: boolean;
};

function resolveWrapOptions(options: WrapOptions): ResolvedWrap {
  return {
    firstPrefix: options.firstPrefix ?? "",
    restPrefix: options.restPrefix ?? "",
    style: options.style ?? ((value: string) => value),
    prefixStyle: options.prefixStyle ?? ((value: string) => value),
    preserveWhitespace: options.preserveWhitespace === true,
  };
}

/** Append wrapped text with optional prefixes and styling. */
export function addWrapped(
  page: PageBuilder,
  view: FormView,
  text: string,
  options: WrapOptions = {},
): void {
  const resolved = resolveWrapOptions(options);
  const wrap = resolved.preserveWhitespace ? wrapByColumn : wrapTextWithAnsi;
  const prefixWidth = visibleWidth(resolved.firstPrefix);
  if (prefixWidth >= page.width || (resolved.preserveWhitespace && page.width - prefixWidth < 2)) {
    for (const line of wrap(
      `${resolved.prefixStyle(resolved.firstPrefix)}${resolved.style(text)}`,
      page.width,
    )) {
      page.add(line);
    }
    return;
  }
  const wrapped = wrap(resolved.style(text), page.width - prefixWidth);
  page.add(`${resolved.prefixStyle(resolved.firstPrefix)}${wrapped[0] ?? ""}`);
  for (let index = 1; index < wrapped.length; index += 1) {
    page.add(`${resolved.prefixStyle(resolved.restPrefix)}${wrapped[index] ?? ""}`);
  }
}

/** Build the full page for the current form state. */
export function buildFormPage(view: FormView, width: number): PageBuilder {
  const page = new PageBuilder(width);
  page.add(view.theme.fg("accent", "─".repeat(page.width)));
  if (view.showTabs && !view.editing) {
    addTabRow(page, view);
  }
  if (view.tab === view.submitTab) {
    addReviewPage(page, view);
  } else {
    addQuestionPage(page, view);
  }
  addFooter(page, view);
  return page;
}

/** The single-line hint shown while the user reads the conversation. */
export function contextHint(theme: Theme, width: number): { line: string; width: number } {
  const hint = truncateToWidth("ctrl+o return to question • scroll conversation", width, "…");
  return { line: theme.fg("dim", hint), width: visibleWidth(hint) };
}

/** Tracks ctrl+o context-reading mode: overlay focus handoff and hint hit-testing. */
export class ContextReader {
  private active = false;
  private hintStart = 0;
  private hintEnd = 0;
  private hintWidth = 0;

  get reading(): boolean {
    return this.active;
  }

  contains(event: { x: number; y: number }): boolean {
    return event.y >= this.hintStart && event.y < this.hintEnd && event.x < this.hintWidth;
  }

  toggle(overlay: OverlayHandle | undefined): void {
    this.active = !this.active;
    if (this.active) {
      overlay?.unfocus({ target: null });
    } else {
      overlay?.focus();
    }
  }

  renderHint(theme: Theme, width: number): string[] {
    const hint = contextHint(theme, width);
    this.hintStart = 0;
    this.hintEnd = 1;
    this.hintWidth = hint.width;
    return [hint.line];
  }

  trackHint(page: PageBuilder): void {
    this.hintStart = page.lines.length - 1;
    this.hintEnd = page.lines.length;
    this.hintWidth = visibleWidth(page.contextHint);
  }
}

/** The inline editor for typed custom answers. */
export function createPromptEditor(tui: TUI, theme: Theme): Editor {
  return new Editor(tui, {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  });
}

/** Reserve terminal rows below the form overlay so the transcript does not shift. */
export function reserveWidgetRows(
  ui: ExtensionContext["ui"],
  widgetKey: string,
  reservedRows: () => number,
): void {
  ui.setWidget(widgetKey, () => ({
    render: () => Array.from({ length: reservedRows() }, () => ""),
    invalidate() {
      // The spacer has no cached output to invalidate.
    },
  }));
}

function addTabRow(page: PageBuilder, view: FormView): void {
  const labels = [
    ...view.questions.map((question, index) => {
      const marker = view.answers.has(question.id) ? "■" : "□";
      const label = ` ${marker} Q${index + 1} `;
      return index === view.tab
        ? view.theme.bg("selectedBg", view.theme.fg("text", label))
        : view.theme.fg("muted", label);
    }),
    view.tab === view.submitTab
      ? view.theme.bg("selectedBg", view.theme.fg("text", " Submit "))
      : view.theme.fg(view.allAnswered() ? "success" : "dim", " Submit "),
  ].join(" ");
  addWrapped(page, view, labels);
  page.add();
}

function addReviewPage(page: PageBuilder, view: FormView): void {
  addWrapped(page, view, view.theme.bold("Review answers"));
  page.add();
  page.beginReview();
  for (const question of view.questions) {
    const answer = view.answers.get(question.id);
    addWrapped(page, view, formatAnswer(answer), {
      firstPrefix: `${question.id}: `,
      restPrefix: " ".repeat(visibleWidth(`${question.id}: `)),
      ...(answer ? {} : { style: (text: string) => view.theme.fg("warning", text) }),
      preserveWhitespace: answer?.selectedOptions !== undefined,
    });
  }
  page.endReview();
  page.add();
  addWrapped(
    page,
    view,
    view.allAnswered()
      ? `${view.keyText("tui.select.confirm")} to submit`
      : "Answer all questions before submitting",
    {
      style: (text) => view.theme.fg(view.allAnswered() ? "success" : "warning", text),
    },
  );
}

function addQuestionPage(page: PageBuilder, view: FormView): void {
  const question = view.current();
  if (question === undefined) {
    return;
  }
  const answer = view.answers.get(question.id);
  page.beginQuestion();
  addWrapped(
    page,
    view,
    question.multiSelect ? `${question.question} (select one or more)` : question.question,
  );
  page.endQuestion();
  page.add();
  page.beginOptions();
  addOptionRows(page, view, question);
  page.endOptions();
  if (answer !== undefined && !view.editing) {
    addAnswerPreview(page, view, question, answer);
  }
  if (view.editing) {
    addEditorLines(page, view);
  }
}

function addOptionRows(page: PageBuilder, view: FormView, question: NormalizedQuestion): void {
  for (const [index, choice] of view.choices().entries()) {
    if (view.editing && index !== view.option) {
      continue;
    }
    const start = page.length - page.optionStart;
    const highlighted = index === view.option;
    const checked = question.multiSelect ? view.selectedSet(question).has(choice) : false;
    let marker: string;
    if (!question.multiSelect) {
      marker = `${index + 1}.`;
    } else if (choice === view.customOption()) {
      marker = "✎";
    } else {
      marker = checked ? "☑" : "☐";
    }
    const prefix = `${highlighted ? ">" : " "} ${marker} `;
    addWrapped(page, view, choice, {
      firstPrefix: prefix,
      restPrefix: " ".repeat(prefix.length),
      style: (text) => view.theme.fg(highlighted ? "accent" : "text", text),
      prefixStyle: (text) =>
        highlighted && text.includes(">") ? view.theme.fg("accent", text) : text,
    });
    page.pushOptionRow(start);
  }
}

function addAnswerPreview(
  page: PageBuilder,
  view: FormView,
  question: NormalizedQuestion,
  answer: Answer,
): void {
  const custom = question.multiSelect ? view.customAnswers.get(question.id) : undefined;
  const selected = question.multiSelect ? view.selectedSet(question) : undefined;
  let summary = answer.answer;
  if (custom !== undefined && selected !== undefined && selected.has(custom)) {
    summary = `${custom} (${selected.size} selected)`;
  }
  const preview = `Current answer: ${summary.replace(/\s+/g, " ")}`;
  page.add(view.theme.fg("muted", truncateToWidth(preview, page.width, "…")));
}

function addEditorLines(page: PageBuilder, view: FormView): void {
  addWrapped(page, view, view.theme.fg("muted", "Your answer:"));
  const indent = page.width > 1 ? " " : "";
  const editorWidth = Math.max(1, page.width - visibleWidth(indent));
  for (const line of view.renderEditor(Math.max(3, editorWidth))) {
    const cursorIndex = line.indexOf(CURSOR_MARKER);
    const cursorColumn = cursorIndex === -1 ? 0 : visibleWidth(line.slice(0, cursorIndex));
    const startColumn = Math.max(0, cursorColumn - editorWidth + 1);
    page.add(`${indent}${sliceByColumn(line, startColumn, editorWidth, true)}`);
  }
}

function footerHints(view: FormView): string {
  if (view.editing) {
    return `${view.keyText("tui.input.submit")} save answer • ${view.keyText("tui.select.cancel")} cancel edit`;
  }
  if (view.showTabs) {
    return `←/→ or ${view.keyText("tui.input.tab")} questions • ${view.keyText("tui.select.up")}/${view.keyText("tui.select.down")} options • Space toggle multi-select • ${view.keyText("tui.select.confirm")} next/submit • ${view.keyText("tui.select.cancel")} cancel`;
  }
  return `${view.keyText("tui.select.up")}/${view.keyText("tui.select.down")} options • ${view.keyText("tui.select.confirm")} select • ${view.keyText("tui.select.cancel")} cancel`;
}

function addFooter(page: PageBuilder, view: FormView): void {
  if (!view.editing) {
    page.add();
  }
  addWrapped(
    page,
    view,
    view.timeoutActive
      ? "Auto-continues after 5 minutes without interaction."
      : "No time limit while you answer.",
    {
      style: (text) => view.theme.fg("dim", text),
    },
  );
  addWrapped(page, view, footerHints(view), {
    style: (text) => view.theme.fg("dim", text),
  });
  const hint = truncateToWidth("ctrl+o read context", page.width, "…");
  page.add(
    `${view.theme.fg("dim", hint)}${view.theme.fg(
      "accent",
      "─".repeat(Math.max(0, page.width - visibleWidth(hint))),
    )}`,
  );
  page.setContextHint(hint);
}
