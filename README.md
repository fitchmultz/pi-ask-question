# pi ask-question extension

A [pi](https://github.com/earendil-works/pi-mono) extension that adds `ask_question`: a model-callable tool with interactive UIs in TUI and RPC modes for asking one or more clarifying questions before work continues. It also adds `/grill-me`, a mode that makes the agent pressure-test underspecified requests before doing the work.

## What it does

- Adds the `ask_question` custom tool
- Supports one question or a sequence of questions
- Supports ordered choices, multi-select, and typed custom answers
- Adds the custom-answer option automatically
- Returns answers in tool result text and structured `details`
- Adds `/grill-me` to toggle pressure-test mode

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

## Grill-me mode

Toggle the mode:

```text
/grill-me
```

Explicit commands:

```text
/grill-me on
/grill-me off
/grill-me status
```

When enabled, the footer shows subtle `grill-mode` text, and the agent is told to walk the decision tree, inspect available repo evidence before asking, ask one blocking question at a time, and include its recommended answer first. It uses `ask_question` in TUI and RPC modes when the tool is active; in print and JSON modes, it asks in normal text instead.

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
- `ask_question` uses its full keyboard UI in TUI mode and sequential Pi dialogs in RPC mode.
- Blank RPC custom answers return to option selection, matching TUI behavior; dismissing the input cancels.
- Print and JSON modes return a tool error because they cannot collect user input.
- `/grill-me` state is saved in the current session branch and survives `/reload`.
- The footer status is cleared when `/grill-me` is disabled.
- `Esc` cancels and reports cancellation to the model.

## Development

```bash
npm install
npm run check
```

Key file:

- `extensions/ask-question.ts` — publishable extension implementation
