/** Cooperative answer-bus protocol: request shapes and validation. */

import { clean } from "./normalize.ts";
import { MAX_REMOTE_ANSWER_LENGTH, type NormalizedQuestion } from "./types.ts";
import { isRecord, isStringArray, validId } from "./validate.ts";

/** A shape-checked request from the cooperative answer bus. */
export type RemoteAnswerRequest = {
  requestId: string;
  [key: string]: unknown;
};

/** The published waiting state for one prompt on the cooperative bus. */
export type WaitingPromptState = {
  status: "waiting";
  protocolVersion: number;
  ownerGeneration: string;
  nativeRoot: string | undefined;
  promptId: string;
  questionId: string;
  revision: number;
  deadline: number;
  timeoutActive: boolean;
  question: string;
  options: string[];
  multiSelect: boolean;
};

/** A validated remote answer, discriminated by kind. */
export type ValidatedRemoteAnswer =
  | { kind: "text"; text: string }
  | { kind: "options"; options: string[] };

/** Shape-check one cooperative-bus answer event. */
export function parseRemoteAnswerRequest(data: unknown): RemoteAnswerRequest | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const requestId = data.requestId;
  if (!validId(requestId)) {
    return undefined;
  }
  return { ...data, requestId };
}

/** Validate an answer payload against the question contract. */
export function validateRemoteAnswer(
  answer: unknown,
  question: NormalizedQuestion,
): ValidatedRemoteAnswer | undefined {
  if (typeof answer === "string") {
    const valid = answer.length <= MAX_REMOTE_ANSWER_LENGTH && clean(answer) !== undefined;
    return valid ? { kind: "text", text: answer } : undefined;
  }
  if (!isStringArray(answer)) {
    return undefined;
  }
  if (!question.multiSelect || !validMultiSelectOptions(answer, question)) {
    return undefined;
  }
  return { kind: "options", options: answer };
}

/** Multi-select answers must be unique, known, and within size limits. */
function validMultiSelectOptions(answer: string[], question: NormalizedQuestion): boolean {
  const unique = new Set(answer).size === answer.length;
  const known = answer.every((value) => question.options.includes(value));
  const sized =
    answer.length > 0 &&
    answer.length <= question.options.length &&
    answer.reduce((size, value) => size + value.length, 0) <= MAX_REMOTE_ANSWER_LENGTH;
  return unique && known && sized;
}
