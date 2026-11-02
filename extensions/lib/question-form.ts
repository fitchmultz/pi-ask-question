/** Full-screen question form component with paging and cooperative answers. */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type Component,
  type Editor,
  type Focusable,
  type Keybinding,
  type KeybindingsManager,
  type OverlayHandle,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { AnswerSheet } from "./form-answers.ts";
import {
  buildFormPage,
  ContextReader,
  createPromptEditor,
  reserveWidgetRows,
  type FormView,
} from "./form-page.ts";
import { FormScrolls } from "./form-scrolls.ts";
import { clean, uniqueOptionLabel } from "./normalize.ts";
import { PromptChannel, type ChannelHost } from "./prompt-channel.ts";
import type { ValidatedRemoteAnswer } from "./remote-answers.ts";
import type { QuestionObserver } from "./question-observer.ts";
import {
  CUSTOM_OPTION,
  type Answer,
  type NormalizedQuestion,
  type QuestionResult,
  type QuestionTimeout,
} from "./types.ts";

/** Wiring the form needs from the registering ask flow. */
export type QuestionFormDeps = {
  questions: NormalizedQuestion[];
  promptId: string;
  ui: ExtensionContext["ui"];
  pi: ExtensionAPI;
  observer: QuestionObserver;
  timeout: QuestionTimeout;
  signal: AbortSignal | undefined;
  onDone: (result: QuestionResult) => void;
};

/** The interactive question form shown by ui.custom in TUI mode. */
export class QuestionForm implements Component, Focusable, FormView, ChannelHost {
  private readonly deps: QuestionFormDeps;
  private readonly tui: TUI;
  readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly sheet = new AnswerSheet();
  private readonly scrolls = new FormScrolls();
  private readonly context = new ContextReader();
  private readonly editor: Editor;
  readonly submitTab: number;
  readonly showTabs: boolean;
  private readonly widgetKey: string;
  private readonly unsubscribeInput: () => void;
  private readonly unsubscribeShutdown: () => void;
  private readonly channel: PromptChannel;
  readonly abort = (): void => this.finish(true);

  tab = 0;
  option = 0;
  editing = false;
  finished = false;

  private overlayHandle: OverlayHandle | undefined;
  private reservedRows = 0;
  private cachedWidth: number | undefined;
  private cachedHeight: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(deps: QuestionFormDeps, tui: TUI, theme: Theme, keys: KeybindingsManager) {
    this.deps = deps;
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.submitTab = deps.questions.length;
    this.showTabs =
      deps.questions.length > 1 || deps.questions.some((question) => question.multiSelect);
    this.widgetKey = `ask-question.${deps.promptId}`;
    this.editor = createPromptEditor(tui, theme);
    this.editor.onSubmit = (value) => {
      this.submitCustomAnswer(value);
    };

    reserveWidgetRows(deps.ui, this.widgetKey, () => this.reservedRows);

    this.unsubscribeInput = tui.addInputListener((data) => {
      if (
        matchesKey(data, Key.ctrl("o")) &&
        (this.context.reading || this.overlayHandle?.isFocused() === true)
      ) {
        this.markInteraction();
        this.toggleContext();
        return { consume: true };
      }
      return;
    });
    this.channel = new PromptChannel(
      {
        pi: deps.pi,
        observer: deps.observer,
        timeout: deps.timeout,
        signal: deps.signal,
        promptId: deps.promptId,
      },
      this,
    );
    this.unsubscribeShutdown = deps.pi.on("session_shutdown", this.abort);

    deps.signal?.addEventListener("abort", this.abort, { once: true });
    if (deps.signal?.aborted === true) {
      this.finish(true);
    }
  }

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    if (this.editor.focused === value) {
      return;
    }
    this.editor.focused = value;
    this.cachedLines = undefined;
    this.tui.requestRender();
  }

  get questions(): NormalizedQuestion[] {
    return this.deps.questions;
  }

  get answers(): Map<string, Answer> {
    return this.sheet.answers;
  }

  get customAnswers(): Map<string, string> {
    return this.sheet.custom;
  }

  get timeoutActive(): boolean {
    return this.deps.timeout.active;
  }

  invalidate(): void {
    this.cachedLines = undefined;
  }

  dispose(): void {
    this.finish(true);
  }

  /** Release subscriptions and widget state without completing the prompt. */
  release(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.deps.signal?.removeEventListener("abort", this.abort);
    this.channel.release();
    this.unsubscribeShutdown();
    this.unsubscribeInput();
    this.deps.ui.setWidget(this.widgetKey, undefined);
  }

  attachOverlay(handle: OverlayHandle): void {
    this.overlayHandle = handle;
    this.channel.announce();
  }

  finish(cancelled: boolean): void {
    if (this.finished) {
      return;
    }
    if (this.context.reading) {
      this.overlayHandle?.focus();
    }
    this.release();
    this.deps.onDone({ answers: this.sheet.ordered(this.deps.questions), cancelled });
  }

  current(): NormalizedQuestion | undefined {
    return this.deps.questions[this.tab];
  }

  customOption(): string {
    return uniqueOptionLabel(CUSTOM_OPTION, this.current()?.options ?? []);
  }

  choices(): string[] {
    return [...(this.current()?.options ?? []), this.customOption()];
  }

  allAnswered(): boolean {
    return this.deps.questions.every((question) => this.sheet.has(question.id));
  }

  selectedSet(question: NormalizedQuestion): Set<string> {
    return this.sheet.selectedSet(question);
  }

  keyText(binding: Keybinding): string {
    return this.keys.getKeys(binding).join("/");
  }

  renderEditor(width: number): string[] {
    return this.editor.render(width);
  }

  private refresh(): void {
    this.cachedLines = undefined;
    this.tui.requestRender();
  }

  private markInteraction(): void {
    if (!this.deps.timeout.stop()) {
      return;
    }
    this.refresh();
    this.channel.publishState();
  }

  private toggleContext(): void {
    if (this.overlayHandle === undefined) {
      return;
    }
    this.context.toggle(this.overlayHandle);
    if (this.context.reading) {
      this.reservedRows = 0;
    }
    this.refresh();
  }

  private moveTab(next: number): void {
    const count = this.deps.questions.length + 1;
    this.tab = (next + count) % count;
    this.option = 0;
    this.scrolls.resetForWidth();
    this.scrolls.reviewScroll = undefined;
    this.editing = false;
    this.editor.setText("");
    this.channel.stateChanged();
    this.refresh();
  }

  private toggleMultiChoice(question: NormalizedQuestion, choice: string): void {
    this.sheet.toggleMultiChoice(question, choice);
    this.sheet.syncMultiAnswer(question);
    this.channel.stateChanged();
    this.scrolls.labelScroll = 0;
    this.refresh();
  }

  private startCustomEdit(question: NormalizedQuestion): void {
    const existing = this.sheet.get(question.id);
    let currentCustom: string | undefined;
    if (question.multiSelect) {
      currentCustom = this.sheet.custom.get(question.id);
    } else if (existing !== undefined && existing.wasCustom) {
      currentCustom = existing.answer;
    }
    this.editor.setText(currentCustom ?? "");
    this.editing = true;
    this.scrolls.resetForWidth();
    this.channel.stateChanged();
    this.refresh();
  }

  private saveMultiCustomAnswer(question: NormalizedQuestion, answer: string): void {
    this.sheet.setMultiCustom(question, answer);
    this.sheet.syncMultiAnswer(question);
    this.channel.stateChanged();
    this.refresh();
  }

  private moveForwardIfAnswered(question: NormalizedQuestion): void {
    if (this.sheet.has(question.id)) {
      this.moveTab(Math.min(this.tab + 1, this.submitTab));
    } else {
      this.refresh();
    }
  }

  private saveSingleAnswer(answer: string, wasCustom: boolean): void {
    const question = this.current();
    if (question === undefined) {
      return;
    }
    this.sheet.setSingle(question, answer, wasCustom);
    this.channel.stateChanged();
    if (this.deps.questions.length === 1) {
      this.finish(false);
    } else {
      this.moveTab(Math.min(this.tab + 1, this.submitTab));
    }
  }

  private submitCustomAnswer(value: string): void {
    const answer = clean(value);
    const question = this.current();
    this.editing = false;
    this.editor.setText("");
    if (answer === undefined || question === undefined) {
      this.channel.stateChanged();
      this.refresh();
      return;
    }
    if (question.multiSelect) {
      this.saveMultiCustomAnswer(question, answer);
    } else {
      this.saveSingleAnswer(answer, true);
    }
  }

  applyRemoteAnswer(question: NormalizedQuestion, validated: ValidatedRemoteAnswer): void {
    if (validated.kind === "text") {
      if (question.multiSelect) {
        this.saveMultiCustomAnswer(question, validated.text.trim());
        this.moveForwardIfAnswered(question);
      } else {
        this.saveSingleAnswer(validated.text.trim(), true);
      }
      return;
    }
    this.sheet.applyOptions(question, validated.options);
    this.sheet.syncMultiAnswer(question);
    this.channel.stateChanged();
    this.moveForwardIfAnswered(question);
  }

  handleInput(data: string): void {
    if (this.finished) {
      return;
    }
    this.markInteraction();
    if (this.editing) {
      this.handleEditingInput(data);
      return;
    }
    if (this.navigateTabs(data)) {
      return;
    }
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.finish(true);
      return;
    }
    if (this.tab === this.submitTab) {
      this.handleSubmitTabInput(data);
      return;
    }
    this.handleOptionInput(data);
  }

  private handleEditingInput(data: string): void {
    if (this.scrolls.maxQuestionScroll > 0 && matchesKey(data, Key.shift("pageUp"))) {
      this.scrolls.pageQuestionUp();
      this.refresh();
      return;
    }
    if (this.scrolls.maxQuestionScroll > 0 && matchesKey(data, Key.shift("pageDown"))) {
      this.scrolls.pageQuestionDown();
      this.refresh();
      return;
    }
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.editing = false;
      this.editor.setText("");
      this.channel.stateChanged();
      this.refresh();
      return;
    }
    this.editor.handleInput(data);
    this.refresh();
  }

  private handleSubmitTabInput(data: string): void {
    // Fullscreen reserves plain Page keys for transcript scrolling.
    if (this.scrolls.maxReviewScroll > 0 && this.isPageUp(data)) {
      this.scrolls.pageReviewUp();
      this.refresh();
      return;
    }
    if (this.scrolls.maxReviewScroll > 0 && this.isPageDown(data)) {
      this.scrolls.pageReviewDown();
      this.refresh();
      return;
    }
    if (this.keys.matches(data, "tui.select.confirm") && this.allAnswered()) {
      this.finish(false);
    }
  }

  private handleOptionInput(data: string): void {
    if (this.scrollQuestionOrChoices(data)) {
      return;
    }
    if (this.moveOptionCursor(data)) {
      return;
    }
    const question = this.current();
    if (question === undefined) {
      return;
    }
    this.selectOption(data, question);
  }

  private isPageUp(data: string): boolean {
    return this.keys.matches(data, "tui.select.pageUp") || matchesKey(data, Key.shift("pageUp"));
  }

  private isPageDown(data: string): boolean {
    return (
      this.keys.matches(data, "tui.select.pageDown") || matchesKey(data, Key.shift("pageDown"))
    );
  }

  private navigateTabs(data: string): boolean {
    if (
      this.showTabs &&
      (matchesKey(data, Key.right) || this.keys.matches(data, "tui.input.tab"))
    ) {
      this.moveTab(this.tab + 1);
      return true;
    }
    if (this.showTabs && (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")))) {
      this.moveTab(this.tab - 1);
      return true;
    }
    return false;
  }

  private scrollQuestionOrChoices(data: string): boolean {
    const canScroll = this.scrolls.maxQuestionScroll > 0 || this.scrolls.maxLabelScroll > 0;
    if (!canScroll) {
      return false;
    }
    if (this.isPageUp(data)) {
      this.scrolls.pageChoiceUp();
      this.refresh();
      return true;
    }
    if (this.isPageDown(data)) {
      this.scrolls.pageChoiceDown();
      this.refresh();
      return true;
    }
    return false;
  }

  private moveOptionCursor(data: string): boolean {
    if (this.keys.matches(data, "tui.select.up")) {
      this.option = Math.max(0, this.option - 1);
      this.scrolls.labelScroll = 0;
      this.refresh();
      return true;
    }
    if (this.keys.matches(data, "tui.select.down")) {
      this.option = Math.min(this.choices().length - 1, this.option + 1);
      this.scrolls.labelScroll = 0;
      this.refresh();
      return true;
    }
    return false;
  }

  private selectOption(data: string, question: NormalizedQuestion): void {
    const options = this.choices();
    if (question.multiSelect && matchesKey(data, Key.space)) {
      this.toggleSpaceSelection(question, options);
      return;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      this.confirmOption(question, options);
    }
  }

  private toggleSpaceSelection(question: NormalizedQuestion, options: string[]): void {
    const picked = options[this.option];
    if (picked === this.customOption()) {
      this.startCustomEdit(question);
    } else if (picked !== undefined) {
      this.toggleMultiChoice(question, picked);
    }
  }

  private confirmOption(question: NormalizedQuestion, options: string[]): void {
    const picked = options[this.option];
    if (picked === this.customOption()) {
      this.startCustomEdit(question);
    } else if (picked !== undefined && question.multiSelect) {
      this.moveForwardIfAnswered(question);
    } else if (picked !== undefined) {
      this.saveSingleAnswer(picked, false);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    this.markInteraction();
    if (event.type === "click" && event.button === "left" && this.context.contains(event)) {
      this.toggleContext();
      return { handled: true };
    }
    return;
  }

  render(width: number): string[] {
    if (this.context.reading) {
      return this.context.renderHint(this.theme, width);
    }
    const height = this.tui.terminal.rows;
    if (
      this.cachedLines !== undefined &&
      this.cachedWidth === width &&
      this.cachedHeight === height
    ) {
      return this.cachedLines;
    }
    if (this.cachedWidth !== width) {
      this.scrolls.resetForWidth();
    }
    const page = buildFormPage(this, width);
    if (this.tab === this.submitTab) {
      this.scrolls.applyReviewScrolling(page, this, height);
    } else {
      this.scrolls.applyQuestionScrolling(page, this, height);
    }
    this.cachedWidth = width;
    this.cachedHeight = height;
    this.cachedLines = page.lines;
    this.context.trackHint(page);
    if (this.reservedRows !== page.lines.length) {
      this.reservedRows = page.lines.length;
      this.tui.requestRender();
    }
    return page.lines;
  }
}
