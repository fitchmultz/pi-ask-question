/** Tool parameter schemas for ask_question. */

import { Type } from "typebox";

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
