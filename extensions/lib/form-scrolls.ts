/** Scroll state and paging math for the question form. */

import { sliceByColumn } from "@earendil-works/pi-tui";

import type { FormView, PageBuilder } from "./form-page.ts";

/** Question-section clipping outcome: how many lines exist and fit. */
type QuestionWindow = {
  lineCount: number;
  rows: number;
};

/** Scroll positions and window sizes for question, choice, and review sections. */
export class FormScrolls {
  optionScroll = 0;
  labelScroll = 0;
  pageRows = 0;
  maxLabelScroll = 0;
  questionScroll = 0;
  questionPageRows = 0;
  maxQuestionScroll = 0;
  reviewScroll: number | undefined;
  reviewPageRows = 0;
  maxReviewScroll = 0;

  resetForWidth(): void {
    this.optionScroll = 0;
    this.labelScroll = 0;
    this.questionScroll = 0;
  }

  pageQuestionUp(): void {
    this.questionScroll = Math.max(0, this.questionScroll - Math.max(1, this.questionPageRows - 1));
  }

  pageQuestionDown(): void {
    this.questionScroll = Math.min(
      this.maxQuestionScroll,
      this.questionScroll + Math.max(1, this.questionPageRows - 1),
    );
  }

  pageChoiceUp(): void {
    if (this.labelScroll > 0) {
      this.labelScroll = Math.max(0, this.labelScroll - Math.max(1, this.pageRows - 1));
    } else {
      this.pageQuestionUp();
    }
  }

  pageChoiceDown(): void {
    if (this.questionScroll < this.maxQuestionScroll) {
      this.pageQuestionDown();
    } else {
      this.labelScroll = Math.min(
        this.maxLabelScroll,
        this.labelScroll + Math.max(1, this.pageRows - 1),
      );
    }
  }

  pageReviewUp(): void {
    this.reviewScroll = Math.max(
      0,
      (this.reviewScroll ?? this.maxReviewScroll) - Math.max(1, this.reviewPageRows - 1),
    );
  }

  pageReviewDown(): void {
    this.reviewScroll = Math.min(
      this.maxReviewScroll,
      (this.reviewScroll ?? this.maxReviewScroll) + Math.max(1, this.reviewPageRows - 1),
    );
  }

  /** Window the question and choice sections to the terminal height. */
  applyQuestionScrolling(page: PageBuilder, view: FormView, height: number): void {
    const questionLines = page.lines.slice(page.questionStart, page.questionEnd);
    const question = this.clipQuestionLines(page, questionLines, view, height);
    this.applyOptionScrolling(page, view, height, question);
  }

  /** Row ranges exist for every rendered choice; indexing is total by construction. */
  private optionRow(page: PageBuilder, index: number): { start: number; end: number } {
    const range = page.optionRows[index];
    if (range !== undefined) {
      return range;
    }
    throw new Error(`ask-question: option row ${index} is missing`);
  }

  private clipQuestionLines(
    page: PageBuilder,
    questionLines: string[],
    view: FormView,
    height: number,
  ): QuestionWindow {
    const selectedRow = view.editing ? 0 : view.option;
    const selectedHeight =
      this.optionRow(page, selectedRow).end - this.optionRow(page, selectedRow).start;
    const room = Math.max(
      2,
      height - (page.lines.length - questionLines.length - (page.optionEnd - page.optionStart)),
    );
    const questionRows = Math.max(1, room - selectedHeight);
    this.maxQuestionScroll = Math.max(0, questionLines.length - questionRows);
    this.questionScroll = Math.min(this.questionScroll, this.maxQuestionScroll);
    this.questionPageRows = questionRows;
    if (this.maxQuestionScroll > 0) {
      page.lines.splice(
        page.questionStart,
        questionLines.length,
        ...questionLines.slice(this.questionScroll, this.questionScroll + questionRows),
      );
      page.shiftOptions(questionLines.length - questionRows);
    }
    return { lineCount: questionLines.length, rows: questionRows };
  }

  private applyOptionScrolling(
    page: PageBuilder,
    view: FormView,
    height: number,
    question: QuestionWindow,
  ): void {
    const optionLines = page.lines.slice(page.optionStart, page.optionEnd);
    const available = Math.max(1, height);
    const visibleOptions = Math.max(1, available - (page.lines.length - optionLines.length));
    let optionStatus = "";
    if (optionLines.length > visibleOptions) {
      optionStatus = this.scrollOptionsIntoView(page, view, optionLines, visibleOptions);
    } else {
      this.optionScroll = 0;
      this.labelScroll = 0;
      this.maxLabelScroll = 0;
    }
    if (this.maxQuestionScroll > 0 || optionStatus !== "") {
      this.addScrollStatus(page, view, optionStatus, question);
    }
  }

  private scrollOptionsIntoView(
    page: PageBuilder,
    view: FormView,
    optionLines: string[],
    visibleOptions: number,
  ): string {
    const selectedRow = view.editing ? 0 : view.option;
    // Scroll at choice boundaries so labels that fit are shown in full.
    this.optionScroll = Math.min(this.optionScroll, selectedRow);
    const end = this.findChoiceWindow(page, selectedRow, visibleOptions);
    while (
      this.optionScroll > 0 &&
      this.optionRow(page, end - 1).end - this.optionRow(page, this.optionScroll - 1).start <=
        visibleOptions
    ) {
      this.optionScroll -= 1;
    }
    this.maxLabelScroll = Math.max(
      0,
      this.optionRow(page, selectedRow).end -
        this.optionRow(page, selectedRow).start -
        visibleOptions,
    );
    this.labelScroll = Math.min(this.labelScroll, this.maxLabelScroll);
    this.pageRows = visibleOptions;
    const startLine = this.optionRow(page, this.optionScroll).start + this.labelScroll;
    const endLine = Math.min(this.optionRow(page, end - 1).end, startLine + visibleOptions);
    const above = this.optionScroll > 0 || this.labelScroll > 0 ? "↑ " : "";
    const below = endLine < optionLines.length ? " ↓" : "";
    page.lines.splice(
      page.optionStart,
      optionLines.length,
      ...optionLines.slice(startLine, endLine),
    );
    return `${above}${view.option + 1}/${view.choices().length}${below}`;
  }

  private findChoiceWindow(page: PageBuilder, selectedRow: number, visibleOptions: number): number {
    while (
      this.optionScroll < selectedRow &&
      this.optionRow(page, selectedRow).end - this.optionRow(page, this.optionScroll).start >
        visibleOptions
    ) {
      this.optionScroll += 1;
    }
    let end = selectedRow + 1;
    while (
      end < page.optionRows.length &&
      this.optionRow(page, end).end - this.optionRow(page, this.optionScroll).start <=
        visibleOptions
    ) {
      end += 1;
    }
    return end;
  }

  private addScrollStatus(
    page: PageBuilder,
    view: FormView,
    optionStatus: string,
    question: QuestionWindow,
  ): void {
    const questionStatus =
      this.maxQuestionScroll > 0
        ? `Q ${this.questionScroll + 1}-${Math.min(
            this.questionScroll + question.rows,
            question.lineCount,
          )}/${question.lineCount}`
        : "";
    const read =
      !view.editing && (this.maxQuestionScroll > 0 || this.maxLabelScroll > 0)
        ? ` • ${view.keyText("tui.select.pageUp")}/${view.keyText("tui.select.pageDown")} read (Shift+Page fullscreen)`
        : "";
    const status =
      view.editing && this.maxQuestionScroll > 0
        ? `Shift+PageUp/Down question • ${questionStatus}`
        : `${[questionStatus, optionStatus].filter(Boolean).join(" • ")}${read}`;
    page.setLine(
      page.optionStart - 1,
      sliceByColumn(view.theme.fg("dim", ` ${status}`), 0, page.width, true),
    );
  }

  /** Window the review section to the terminal height, sticking to the end. */
  applyReviewScrolling(page: PageBuilder, view: FormView, height: number): void {
    const answerLines = page.lines.slice(page.reviewStart, page.reviewEnd);
    const visibleAnswers = Math.max(1, height - (page.lines.length - answerLines.length));
    const wasAtEnd = this.reviewScroll === undefined || this.reviewScroll === this.maxReviewScroll;
    this.maxReviewScroll = Math.max(0, answerLines.length - visibleAnswers);
    this.reviewScroll = wasAtEnd
      ? this.maxReviewScroll
      : Math.min(this.reviewScroll ?? 0, this.maxReviewScroll);
    this.reviewPageRows = visibleAnswers;
    if (this.maxReviewScroll > 0) {
      const above = this.reviewScroll > 0 ? "↑ " : "";
      const below = this.reviewScroll < this.maxReviewScroll ? " ↓" : "";
      const read = `${view.keyText("tui.select.pageUp")}/${view.keyText("tui.select.pageDown")} read answers (Shift+Page fullscreen)`;
      page.setLine(
        page.reviewStart - 1,
        sliceByColumn(view.theme.fg("dim", ` ${above}${read}${below}`), 0, page.width, true),
      );
      page.lines.splice(
        page.reviewStart,
        answerLines.length,
        ...answerLines.slice(this.reviewScroll, this.reviewScroll + visibleAnswers),
      );
    }
  }
}
