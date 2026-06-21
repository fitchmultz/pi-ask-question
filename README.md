# pi ask-question extension

A [pi](https://github.com/earendil-works/pi-mono) extension that adds `ask_question`: a model-callable TUI tool for asking one or more clarifying questions before work continues.

## What it does

- Adds the `ask_question` custom tool
- Supports one question or a sequence of questions
- Supports ordered choices, multi-select, and typed custom answers
- Adds the custom-answer option automatically
- Returns answers in tool result text and structured `details`

## Install

Install it from npm with pi:

```bash
pi install npm:pi-ask-question
```

Or install it directly from GitHub with pi:

```bash
pi install https://github.com/fitchmultz/pi-ask-question
```

Then reload pi from inside the app:

```text
/reload
```

For local development:

```bash
pi -e ./extensions/ask-question.ts
```

## Tool shape

Ask one question:

```json
{
  "question": "Which implementation should I use?",
  "options": ["Smallest working change", "Full refactor"],
  "multiSelect": false
}
```

Ask several questions:

```json
{
  "questions": [
    {
      "id": "scope",
      "question": "What scope should I use?",
      "options": ["Minimal", "Complete"]
    },
    {
      "id": "checks",
      "question": "Which checks should I run?",
      "options": ["Typecheck", "Tests", "Runtime smoke"],
      "multiSelect": true
    }
  ]
}
```

## Behavior notes

- Options should be ordered from most recommended to least recommended.
- Do not include a custom-answer option; the UI adds one.
- `ask_question` requires an interactive pi UI.
- `Esc` cancels and reports cancellation to the model.

## Development

```bash
npm install
npm run check
```

Key file:

- `extensions/ask-question.ts` — publishable extension implementation
