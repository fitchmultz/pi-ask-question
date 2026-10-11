# ask_question reference

[Back to the README](../README.md)

## Installation and updates

The owned npm package is `@fitchmultz/pi-ask-question`:

```bash
pi install npm:@fitchmultz/pi-ask-question
```

GitHub remains a supported fallback, including existing tags:

```bash
pi install https://github.com/fitchmultz/pi-ask-question
```

Use `/reload` after updating extension code on current official Pi and the maintained fork. Restart Pi after changing dependencies or the host runtime.

## Tool shape

The extension adds the model-callable `ask_question` tool. It accepts a single question or a sequence, with ordered choices, multi-select, and typed custom answers. The UI adds the custom-answer option automatically.

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

A nonempty `questions` array takes precedence over the single-question fields. IDs default to `question_<n>`; duplicate IDs are auto-suffixed. `multiSelect` defaults to `false`.

For tool callers:

- Order options from most recommended to least recommended.
- Do not include a custom-answer option; the UI adds one.
- Use multi-select only when the user may need to choose more than one option.

## Results

Answers are returned in tool result text and structured `details`:

- `questions` contains the normalized questions.
- `answers` contains saved answers with `id`, `question`, `answer`, and `wasCustom`.
- Multi-select answers also contain `selectedOptions`. Tool text and the review show an unambiguous JSON array; the comma-joined `answer` field remains available.
- `cancelled` reports user or caller cancellation.
- `timedOut` reports the five-minute deadline separately from cancellation.

The configured selection-cancel binding cancels the question and reports cancellation to the model.

## UI behavior

- `ask_question` uses its full keyboard UI in TUI mode and sequential Pi dialogs in RPC mode.
- RPC multi-select dialogs mark selected choices with ☑ and unselected choices with ☐. Choose a checked choice again to remove it, including a custom answer.
- TUI questions appear over the current screen, temporarily covering the footer and widgets while preserving the editor draft. Long lists scroll by complete wrapped choices with Up/Down.
- PageUp/PageDown let you read a question, choice, or answer review longer than the screen. Shift+PageUp/Shift+PageDown also work in fullscreen.
- While typing a custom answer, the list shows only that choice; Escape returns to the list. Shift+PageUp/Shift+PageDown can scroll a long question while editing.
- Saved answers have a one-line preview while choosing; the review retains their full text.
- Blank RPC custom answers return to option selection, matching TUI behavior; dismissing the input cancels.
- Print and JSON modes return a tool error because they cannot collect user input.

### Terminal controls

These are the default controls; the UI shows your configured bindings.

| Action | Control |
| --- | --- |
| Move through choices | Up/Down |
| Select a single answer | Enter |
| Toggle multi-select choices | Space |
| Move on after selecting at least one multi-select answer | Enter |
| Switch between questions and the final review (question sets and multi-select) | Left/Right or Tab; Shift+Tab moves back |
| Submit from the final review | Enter |
| Read long questions, choices, or reviews | PageUp/PageDown; Shift+PageUp/Shift+PageDown in fullscreen |
| Read a long question while editing a custom answer | Shift+PageUp/Shift+PageDown |
| Cancel the question, or return from a custom-answer edit to the choices | Escape |

## Five-minute timeout

Each `ask_question` call has one five-minute limit, shared across all questions and dialogs. Answering part of a question set does not restart the timer.

At timeout, the tool returns:

> Mitch is currently AFK. Use your best judgement to choose the option Mitch would choose.

It reports `timedOut: true`, not cancellation, and does not select an option or invent a user answer. Saved answers and multi-select choices are preserved; unfinished custom-answer text is not submitted.

The timeout closes the TUI question and stops server-side waiting in RPC mode. RPC clients are responsible for dismissing their own dialogs; Pi does not send a dismissal event.

## Grill-me mode

`/grill-me` toggles pressure-test mode. Explicit commands are `/grill-me on`, `/grill-me off`, and `/grill-me status`.

When enabled, the footer shows subtle `grill-mode` text. The agent is told to walk the decision tree, inspect available repository evidence before asking, ask one blocking question at a time, and include its recommended answer first. It uses `ask_question` in TUI and RPC modes when the tool is active; without an active tool or in print and JSON modes, it asks in normal text instead.

The setting is saved in the current session branch and survives `/reload`. The footer status is cleared when disabled.

## Cooperative TUI answers

This bridge is currently listed under [Unreleased in the changelog](../CHANGELOG.md#unreleased). Use the Git source to work with it before the next npm release.

Trusted extensions can observe and answer the **live TUI** question through the shared `pi.events` bus. This does not open a socket, start a process, queue model input, or simulate keyboard/focus actions. RPC clients continue using Pi's extension UI response protocol; other extensions' dialogs are not remotely answerable through this bridge.

Events:

```typescript
// pi-ask-question:state
{ status: "waiting", promptId: string, questionId: string, revision: number,
  question: string, options: string[], multiSelect: boolean }
{ status: "closed", promptId: string }

// pi-ask-question:answer
{ requestId: string, promptId: string, questionId: string, revision: number,
  answer: string | string[] }

// pi-ask-question:result
{ requestId: string, promptId: string, status: "answered" | "stale" | "invalid" }
```

- Freeze all three target fields from `waiting`; never retarget a delayed reply. `promptId` is unique per tool call, `questionId` is the normalized answer ID, and `revision` changes on active-question or saved-answer changes.
- A string is the same custom answer as typing locally: outer whitespace is trimmed, but even an exact option label remains custom text. No fuzzy option matching, comma splitting, or command expansion.
- An array is allowed only for multi-select: a nonempty set of unique, **exact** existing option labels. It replaces the selected set, preserving array order and labels containing commas. A string for multi-select saves its custom choice alongside existing selections.
- Answers are limited to 16,384 UTF-16 code units (summed across an array). `requestId` must be nonblank and at most 128 code units; use a new ID for each commit. At most 1,024 commits are accepted per prompt.
- `answered` is emitted only after the owner applies the answer. Remote commits advance to the next question and submit once every question has an answer. Keyboard-only workflows retain the review and manual submission.
- Local changes invalidate earlier revisions immediately, before the coalesced state event. Custom editing and the review emit `closed` to withdraw the remote target; returning to a question emits a new `waiting` target. `closed` therefore does not necessarily mean the whole tool call ended.
- Invalid payloads do not change the question. Stale revisions/questions and reused accepted request IDs return `stale`. An unknown prompt, malformed request ID, or disposed owner may not respond at all; treat a missing receipt as expired, never successful.
- Answer listeners are live only while the TUI owner exists and are removed idempotently on completion, disposal, timeout, abort, and session shutdown/reload. All questions still share the original single five-minute deadline.
