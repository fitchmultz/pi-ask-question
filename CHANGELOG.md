# Changelog

## Unreleased

- Add `/grill-me` pressure-test mode that survives `/reload`.
- Tighten `/grill-me` prompts to inspect first, walk the decision tree, and ask one recommended question at a time.
- Support `ask_question` through Pi's RPC extension UI protocol, including ordered multi-question and multi-select flows.
- Use `ask_question` for `/grill-me` in both TUI and RPC UI modes.
- Retry option selection after blank RPC custom input, matching TUI behavior.
- Forward tool cancellation to TUI and RPC dialogs.
- Keep print/JSON behavior explicit: the tool fails because no user-input UI is available.
- Name `ask_question` in every prompt guideline as required by Pi's flattened prompt metadata.
- Update development dependencies and validation to Pi 0.80.6.

## 0.2.0 — 2026-06-24

- Fix text wrapping to be ANSI/wide-glyph safe via `wrapTextWithAnsi`/`visibleWidth` (replaces naive `.length` math that overflowed on CJK/emoji).
- Mark `ask_question` `executionMode: "sequential"` so concurrent calls cannot fight for keyboard focus.
- Add compact `renderCall`/`renderResult` for the tool (question count/ids, answers, cancelled).
- Add `/grill-me` argument completion (`on`, `off`, `status`).
- Skip the grill-me footer status update outside TUI mode.
- Auto-suffix duplicate `questions[].id` instead of colliding in the answers map.
- Trim `ask_question` prompt guidelines from 6 bullets to 3 to cut system-prompt tax.
- Document single-vs-`questions` precedence and default id behavior in the schema.

## 0.1.0

- Package the existing `ask_question` extension as `pi-ask-question`.
