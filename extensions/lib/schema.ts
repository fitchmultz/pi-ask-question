/** Tool parameter schemas for ask_question. */

import { Type, type Static } from "typebox";
import { isRecord } from "./validate.ts";

const QuestionSchema = Type.Object(
  {
    id: Type.Optional(
      Type.String({
        description: "Stable answer id. Defaults to question_<n>; duplicates are auto-suffixed.",
      }),
    ),
    question: Type.String({ minLength: 1, description: "Question to ask the user." }),
    options: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Choices, ordered from most recommended to least recommended.",
      }),
    ),
    multiSelect: Type.Optional(
      Type.Boolean({
        description: "Allow selecting more than one option for this question. Defaults to false.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const AskQuestionParams = Type.Object(
  {
    question: Type.Optional(Type.String({ minLength: 1, description: "Single question to ask." })),
    options: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Choices, ordered from most recommended to least recommended.",
      }),
    ),
    multiSelect: Type.Optional(
      Type.Boolean({
        description:
          "Allow selecting more than one option for the single question. Defaults to false.",
      }),
    ),
    questions: Type.Optional(
      Type.Array(QuestionSchema, {
        description:
          "Ask several questions in order. When provided, takes precedence over the single-question fields.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** The record with one field read as the list its JSON string holds. Any other value is unchanged. */
function withListField(
  value: unknown,
  field: "options" | "questions",
  isItem: (item: unknown) => boolean,
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const text = value[field];
  if (typeof text !== "string") {
    return value;
  }
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return value;
  }
  return Array.isArray(list) && list.every(isItem) ? { ...value, [field]: list } : value;
}

const isText = (item: unknown): boolean => typeof item === "string";

/**
 * Read a list that the model sent as one JSON string as that list.
 *
 * Pi calls this with the model's raw arguments, before it converts and validates them. Left alone,
 * Pi turns a string in a list field into a list with that one item: a single option that shows the
 * whole list text, or a `questions` entry it rejects. Only a string that is a JSON list of the
 * right items changes: text for `options`, objects for `questions`. Pi validates the result.
 */
export function prepareAskQuestionArguments(args: unknown): Static<typeof AskQuestionParams> {
  const single = withListField(withListField(args, "options", isText), "questions", isRecord);
  const prepared =
    isRecord(single) && Array.isArray(single.questions)
      ? {
          ...single,
          questions: single.questions.map((question: unknown) =>
            withListField(question, "options", isText),
          ),
        }
      : single;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-007: the Pi SDK types prepareArguments as returning the validated parameters, although Pi validates the returned value afterwards.
  return prepared as Static<typeof AskQuestionParams>;
}
