# pi ask-question extension

A [pi](https://github.com/earendil-works/pi-mono) extension that adds `ask_question`: a model-callable tool with interactive UIs in TUI and RPC modes for asking one or more clarifying questions before work continues. It also adds `/grill-me`, a mode that makes the agent pressure-test underspecified requests before doing the work.

## What it does

- Adds the `ask_question` custom tool
- Supports one question or a sequence of questions
- Supports ordered choices, multi-select, and typed custom answers
- Adds the custom-answer option automatically
- Returns answers in tool result text and structured `details`
- Stops waiting after five minutes and lets the agent continue with an AFK reply
- Adds `/grill-me` to toggle pressure-test mode

## Requirements

- Pi 0.84.0 or later

## Install

Install it directly from GitHub with pi:

```bash
pi install https://github.com/fitchmultz/pi-ask-question
```

Restart Pi after installing or updating extension code or dependencies. The maintained fork's `/reload` refreshes resources and reinitializes cached code; it does not apply code updates.

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
- Multi-select results include `selectedOptions` in `details.answers`; tool text and the Review tab show an unambiguous JSON array. The existing comma-joined `answer` field remains available.
- `ask_question` uses its full keyboard UI in TUI mode and sequential Pi dialogs in RPC mode.
- RPC multi-select dialogs show the current selections; choose one again to remove it, including a custom answer.
- TUI questions appear over the current screen, temporarily covering the footer and widgets while preserving the editor draft. Long lists scroll by complete wrapped choices with Up/Down.
- PageUp/PageDown let you read a question, choice, or answer review longer than the screen; Shift+PageUp/Shift+PageDown also work in fullscreen on older Pi. While typing a custom answer, the list shows only that choice; Escape returns to the list.
- Saved answers have a one-line preview while choosing; the Review tab retains their full text.
- Each `ask_question` call has one five-minute limit, shared across all questions and dialogs. Answering part of a question set does not restart the timer.
- At timeout, the tool returns: “Mitch is currently AFK. Use your best judgement to choose the option Mitch would choose.” It reports `timedOut: true`, not cancellation, and does not select an option or invent a user answer.
- Saved answers and multi-select choices are preserved on timeout; unfinished custom-answer text is not submitted.
- The timeout closes the TUI question and stops server-side waiting in RPC mode. RPC clients are responsible for dismissing their own dialogs; Pi does not send a dismissal event.
- Blank RPC custom answers return to option selection, matching TUI behavior; dismissing the input cancels.
- Print and JSON modes return a tool error because they cannot collect user input.
- `/grill-me` state is saved in the current session branch and survives `/reload`.
- The footer status is cleared when `/grill-me` is disabled.
- The configured selection-cancel binding cancels and reports cancellation to the model.

## Development

```bash
npm install
npm run check:compat # all behavior tests + typecheck + pack dry-run
```

The development Pi cohort is pinned to official `0.86.1`; the declared `0.84.0` floor is a separate target. Runtime host peers remain wildcard, and no production build or `prepare` is needed. Tests resolve the selected host from this checkout's `node_modules`.

`tests/native-tui.test.ts` loads the extension through Pi's native SDK and runs `InteractiveMode` with an in-memory `Terminal`. It checks answer, Escape, caller abort, short-terminal choices and editing, paging, resize, fullscreen, and widget overlap, plus draft and keyboard ownership restoration. It does not touch the process terminal or clipboard, use provider credentials, or make model calls. Have `fd` and `rg` on PATH for native TUI initialization without downloads. Existing unit tests retain timeout, RPC dialog, custom answer, multi-select, and grill-mode coverage; this native TUI test is not a real RPC-client qualification.

Key file:

- `extensions/ask-question.ts` — publishable extension implementation
