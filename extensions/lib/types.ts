/** Shared domain types and constants for the ask_question extension. */

/** A single question as received through the tool schema. */
export type Question = {
  id?: string;
  question: string;
  options?: string[];
  multiSelect?: boolean;
};

/** A question after normalization: identified, cleaned, and complete. */
export type NormalizedQuestion = {
  id: string;
  question: string;
  options: string[];
  multiSelect: boolean;
};

/** A user answer for one question. */
export type Answer = {
  id: string;
  question: string;
  answer: string;
  selectedOptions?: string[];
  wasCustom: boolean;
};

/** Structured details attached to a finished ask_question tool result. */
export type AskQuestionDetails = {
  questions: NormalizedQuestion[];
  answers: Answer[];
  cancelled: boolean;
  timedOut: boolean;
};

/** Outcome of asking one question set through any UI mode. */
export type QuestionResult = {
  answers: Answer[];
  cancelled: boolean;
};

/** Cooperative five-minute inactivity timeout for one question set. */
export type QuestionTimeout = {
  deadline: number;
  readonly active: boolean;
  stop: () => boolean;
};

export const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
export const TIMEOUT_MESSAGE =
  "Mitch is currently AFK. A timeout does not grant missing approval; continue already-authorized work and use your best judgement for routine choices.";
export const CUSTOM_OPTION = "Type a custom answer";
export const DONE_OPTION = "Done selecting";
export const MAX_REMOTE_ANSWER_LENGTH = 16_384;
// ponytail: bound deduplication to 1024 commits per prompt; raise with a higher-volume client.
export const MAX_REMOTE_REQUESTS = 1024;
