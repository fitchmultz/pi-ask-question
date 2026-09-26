# Changelog

## Unreleased

- Require Node.js 24 and Pi 0.86.1, and update the development toolchain to TypeScript 7.
- Compose `/grill-me` guidance with later extension prompt changes instead of replacing the full system prompt.
- Allow RPC multi-select answers to be deselected, including custom answers.
- Preserve exact multi-select choices in tool results and review, including labels containing commas.
- Keep selected choices visible in short terminals and after resizing, with scrolling for long questions, choices, and answer reviews.

## 0.4.0 — 2026-09-07

- Stop waiting after five minutes per `ask_question` call and return an AFK reply so the agent can continue using its best judgement.
- Preserve saved answers and multi-select choices on timeout, and report timeout separately from user cancellation.

## 0.3.0 — 2026-08-06

- Require Pi 0.84.0 or later.
- Keep the interactive question layout width-safe after terminal resizes, including Pi 0.84's fullscreen TUI mode.
- Forward custom-component focus to the embedded editor so IME candidate windows follow the active answer field.
- Add `/grill-me` pressure-test mode that survives `/reload`.
- Tighten `/grill-me` prompts to inspect first, walk the decision tree, and ask one recommended question at a time.
- Support `ask_question` through Pi's RPC extension UI protocol, including ordered multi-question and multi-select flows.
- Use `ask_question` for `/grill-me` in both TUI and RPC UI modes.
- Retry option selection after blank RPC custom input, matching TUI behavior.
- Forward tool cancellation to TUI and RPC dialogs.
- Keep print/JSON behavior explicit: the tool fails because no user-input UI is available.
- Name `ask_question` in every prompt guideline as required by Pi's flattened prompt metadata.

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
