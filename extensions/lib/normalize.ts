/** Question normalization and answer summarizing. */

import { TIMEOUT_MESSAGE, type Answer, type NormalizedQuestion, type Question } from "./types.ts";

/** Trim a value and drop empty results; undefined passes through. */
export function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

/** Add a numeric suffix until the label no longer collides with existing options. */
export function uniqueOptionLabel(label: string, options: string[]): string {
  let result = label;
  for (let suffix = 2; options.includes(result); suffix += 1) {
    result = `${label} (${suffix})`;
  }
  return result;
}

/** Normalize schema input into complete, deduplicated questions. */
export function normalize(params: {
  question?: string;
  options?: string[];
  multiSelect?: boolean;
  questions?: Question[];
}): NormalizedQuestion[] {
  const questions = params.questions;
  const raw =
    questions !== undefined && questions.length > 0
      ? questions
      : [
          {
            id: "question_1",
            question: params.question ?? "",
            options: params.options,
            multiSelect: params.multiSelect,
          },
        ];

  const assigned = new Set<string>();
  const result: NormalizedQuestion[] = [];

  for (const [index, question] of raw.entries()) {
    const text = clean(question.question);
    if (text === undefined) {
      continue;
    }

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
        .filter((option): option is string => option !== undefined),
      multiSelect: question.multiSelect === true,
    });
  }

  return result;
}

/** Answers in question order, skipping unanswered questions. */
export function orderedAnswers(
  questions: NormalizedQuestion[],
  answers: Map<string, Answer>,
): Answer[] {
  return questions
    .map((question) => answers.get(question.id))
    .filter((answer): answer is Answer => answer !== undefined);
}

/** One-line rendering of an answer for summaries and the review page. */
export function formatAnswer(answer: Answer | undefined): string {
  if (answer === undefined) {
    return "unanswered";
  }
  return answer.selectedOptions !== undefined
    ? JSON.stringify(answer.selectedOptions)
    : answer.answer;
}

/** Human-readable summary returned as the tool result text. */
export function summarize(
  questions: NormalizedQuestion[],
  answers: Map<string, Answer>,
  cancelled: boolean,
  timedOut: boolean,
): string {
  if (timedOut) {
    return [
      `Timed out after 5 minutes. ${TIMEOUT_MESSAGE}`,
      ...(answers.size > 0
        ? [
            "",
            "Answers already provided:",
            ...orderedAnswers(questions, answers).map(
              (answer) => `- ${answer.id}: ${formatAnswer(answer)}`,
            ),
          ]
        : []),
    ].join("\n");
  }
  if (cancelled) {
    return "User cancelled the question.";
  }
  const [only] = questions;
  if (questions.length === 1 && only !== undefined) {
    return `User answered: ${formatAnswer(answers.get(only.id))}`;
  }
  return [
    "User answered:",
    ...questions.map((question) => `- ${question.id}: ${formatAnswer(answers.get(question.id))}`),
  ].join("\n");
}
