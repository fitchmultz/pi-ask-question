# Changelog

## Unreleased

## 0.6.4 - 2026-11-01

<!-- npm-release:unreleased:start -->
<!-- npm-release:unreleased:end -->

- Use direct Flash for automatic release remediation (#55) ([1d83a5e](https://github.com/fitchmultz/pi-ask-question/commit/1d83a5e551215db5318ac4f4f0ae37f8ac1af49c))

### What's Changed
* Use direct Flash for necessary release remediation by @fitchmultz in https://github.com/fitchmultz/pi-ask-question/pull/55


**Full Changelog**: https://github.com/fitchmultz/pi-ask-question/compare/v0.6.3...v0.6.4

## 0.6.3 - 2026-11-01

<!-- npm-release:unreleased:start -->
<!-- npm-release:unreleased:end -->

- Pin reviewed release source binding (#53) ([c5201e4](https://github.com/fitchmultz/pi-ask-question/commit/c5201e4fd8d10799b5db05e90fb25d7ac644003f))

### What's Changed
* Bind automatic releases to the reviewed version by @fitchmultz in https://github.com/fitchmultz/pi-ask-question/pull/53


**Full Changelog**: https://github.com/fitchmultz/pi-ask-question/compare/v0.6.2...v0.6.3

## 0.6.2 - 2026-10-31

<!-- npm-release:unreleased:start -->
- Clarify compatibility and release guidance and remove outdated Git-only advice for the cooperative question bridge.
<!-- npm-release:unreleased:end -->

- Automate reviewed npm patch releases (#51) ([e00bcb5](https://github.com/fitchmultz/pi-ask-question/commit/e00bcb54c99e0144ff0bfdc2249bfeef350ac413))

### What's Changed
* Clarify compatibility and release guidance by @fitchmultz in https://github.com/fitchmultz/pi-ask-question/pull/50
* Automate reviewed npm patch releases by @fitchmultz in https://github.com/fitchmultz/pi-ask-question/pull/51


**Full Changelog**: https://github.com/fitchmultz/pi-ask-question/compare/v0.6.1...v0.6.2

## 0.6.1 — 2026-10-31

- Disable the AFK timeout after TUI interaction or a submitted RPC choice, so an in-progress answer remains open.

## 0.6.0 — 2026-10-31

- Keep preceding conversation text visible above TUI questions and let users read the transcript without cancelling or losing their answer.
- Let cooperative observers query a current TUI question after attachment, including its original deadline and runtime owner, and reconcile accepted answer IDs after a lost result without reapplying them.
- Rewrite the README for human readers, add a question-flow diagram, and move API and maintainer details into linked guides.
- Add a cooperative `pi.events` bridge for exact, correlated answers to live TUI questions, with receipts after applying the existing answer state.
- Preserve local keyboard/dialog behavior and the shared five-minute deadline; reject stale/duplicate replies and dispose subscriptions on completion, cancellation, timeout, and reload.
- Support literal custom text and exact multi-select arrays without interpreting speech as option approvals.

## 0.5.1 — 2026-10-04

- Distribute this project publicly as `@fitchmultz/pi-ask-question`, preserving the existing version line, Git installation, `ask_question` tool, and `/grill-me` behavior.
- Lead installation guidance with the owned scoped package.
- Qualify the latest stable official Pi and maintained fork main once per run, freezing their SDK and companion graphs across existing TUI/RPC, type, package, and native install checks.
- Add a main-only, opt-in repository npm release pipeline that requires both host qualifications before publishing.

## 0.5.0 — 2026-10-01

- Require Pi 1.0.0 and Node.js 24, and qualify the exact official Pi 1.0.0 / TypeBox 1.3.27 cohort while retaining host-provided runtime peers.
- Update repository typechecking from TypeScript 6 to TypeScript 7.0.2.
- Exercise answer, Escape and caller abort in both default fullscreen and regular mode, preserving the editor draft and restoring focus.
- Add bundled-CLI RPC dialog coverage for multi-select, typed answers, cancellation and recovery after reload, and native SDK grill-mode tree/fork/resume/reload coverage.
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
