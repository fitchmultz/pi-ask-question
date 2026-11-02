/** Answer bookkeeping for the question form: single, multi-select, and custom answers. */

import { orderedAnswers } from "./normalize.ts";
import type { Answer, NormalizedQuestion } from "./types.ts";

/** The answer model for one prompt; the form orchestrates view updates around it. */
export class AnswerSheet {
  readonly answers = new Map<string, Answer>();
  private readonly multi = new Map<string, Set<string>>();
  readonly custom = new Map<string, string>();

  has(questionId: string): boolean {
    return this.answers.has(questionId);
  }

  get(questionId: string): Answer | undefined {
    return this.answers.get(questionId);
  }

  ordered(questions: NormalizedQuestion[]): Answer[] {
    return orderedAnswers(questions, this.answers);
  }

  selectedSet(question: NormalizedQuestion): Set<string> {
    let selected = this.multi.get(question.id);
    if (selected === undefined) {
      selected = new Set<string>();
      this.multi.set(question.id, selected);
    }
    return selected;
  }

  /** Write the joined multi-select answer; deletes it when nothing is selected. */
  syncMultiAnswer(question: NormalizedQuestion): void {
    const selected = [...this.selectedSet(question)];
    if (selected.length === 0) {
      this.answers.delete(question.id);
      return;
    }
    this.answers.set(question.id, {
      id: question.id,
      question: question.question,
      answer: selected.join(", "),
      selectedOptions: selected,
      wasCustom: selected.some((answer) => !question.options.includes(answer)),
    });
  }

  toggleMultiChoice(question: NormalizedQuestion, choice: string): void {
    const selected = this.selectedSet(question);
    if (selected.has(choice)) {
      selected.delete(choice);
    } else {
      selected.add(choice);
    }
  }

  setMultiCustom(question: NormalizedQuestion, answer: string): void {
    const selected = this.selectedSet(question);
    const previous = this.custom.get(question.id);
    if (previous !== undefined) {
      selected.delete(previous);
    }
    this.custom.set(question.id, answer);
    selected.add(answer);
  }

  setSingle(question: NormalizedQuestion, answer: string, wasCustom: boolean): void {
    this.answers.set(question.id, {
      id: question.id,
      question: question.question,
      answer,
      wasCustom,
    });
  }

  /** Replace the multi-select choices and forget any custom answer. */
  applyOptions(question: NormalizedQuestion, choices: string[]): void {
    const selected = this.selectedSet(question);
    selected.clear();
    this.custom.delete(question.id);
    for (const choice of choices) {
      selected.add(choice);
    }
  }
}
