# Quality-exception record

Quality exceptions under [the Strict Oxlint and Oxfmt Engineering Standard](../strict-oxlint-oxfmt-standard.md), Section 2. Each entry uses the Appendix B record format with a stable identifier.

## QX-001: Five-parameter `execute` callback for `ask_question`

```text
ID and title: QX-001 — five-parameter execute callback for ask_question
Rule, option, or threshold; installed tool versions: eslint/max-params (max 4); oxlint 1.90.0, oxlint-tsgolint 7.0.2005
Scope: extensions/lib/tool.ts, the single defineTool execute callback
Directive selectors/inventory and optional duplication bounds: one next-line directive on the execute callback; no other site
Diagnostic and required contract: execute declares five parameters (_toolCallId, params, signal, _onUpdate, ctx). The Pi SDK fixes this positional contract: "Execute the tool." execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionToolContext) in @earendil-works/pi-coding-agent dist/core/extensions/types.d.ts. defineTool's callback type is not repo-owned and cannot be reshaped.
Actual compliant alternative and demonstrated quality cost: none available. Parameters are positional and semantic (abort signal, update callback, tool context); dropping or reordering them breaks the SDK callback type. Bundling them into a local wrapper object would add a re-packing layer around an SDK-fixed signature with no behavioral or readability gain.
Chosen adjustment and why its scope is appropriate: next-line eslint/max-params directive on that one callback, identified QX-001. All other functions in the repository remain under the four-parameter limit.
Structural comparison or unsafe-type evidence, where applicable: not applicable (imposed API arity, not structure).
Verification commands, relevant tests, and results: npm run typecheck (0 errors); npm test (74/74 pass, includes ask_question execution tests); npx oxlint --deny-warnings extensions (0 findings).
Retained protection, lost detection, and established assumptions: only this callback's arity is exempt; any additional-parameter mistake elsewhere (or a sixth parameter here) still fails lint.
Review and revisit trigger: if the Pi SDK changes the execute callback shape, or the directive count grows beyond one, re-evaluate.
```

## QX-002: Handler mutation of `systemPromptOptions.sections` in /grill-me

```text
ID and title: QX-002 — handler mutation of systemPromptOptions.sections in /grill-me
Rule, option, or threshold; installed tool versions: eslint/no-param-reassign (props); oxlint 1.90.0, oxlint-tsgolint 7.0.2005
Scope: extensions/lib/grill-me.ts, the before_agent_start handler's grill_me section assignment; tests/native-tui.test.ts, the test extension's two before_agent_start assignments (cwd and sections.policy) that verify the same contract
Directive selectors/inventory and optional duplication bounds: one next-line directive on the sections assignment in grill-me.ts; one next-line directive on each of the two assignments in the native-tui test extension; no other sites
Diagnostic and required contract: event.systemPromptOptions.sections.grill_me = guidance assigns to a property of the event parameter. The Pi SDK documents this as the supported contract: "Mutable prompt sections. Later handlers observe mutations made by earlier handlers." (BeforeAgentStartEventBase.systemPromptOptions, @earendil-works/pi-coding-agent dist/core/extensions/types.d.ts). Section injection is the intended mechanism for augmenting the composed system prompt.
Actual compliant alternative and demonstrated quality cost: returning BeforeAgentStartEventResult with a full systemPrompt string replaces the entire composed prompt rather than adding one section, and would require this repository to duplicate Pi's prompt assembly to preserve unrelated sections. The handler already uses the return path where the SDK requires it (forceSystemPrompt is set).
Chosen adjustment and why its scope is appropriate: next-line eslint/no-param-reassign directive on the single documented-mutation assignment, identified QX-002. All other parameter assignments remain enforced.
Structural comparison or unsafe-type evidence, where applicable: not applicable (documented mutable contract, not structure).
Verification commands, relevant tests, and results: npm run typecheck (0 errors); npm test (74/74 pass, including grill-me section injection assertions on systemPromptOptions.sections["grill_me"] in tests/ask-question.test.ts); npx oxlint --deny-warnings extensions (0 findings).
Retained protection, lost detection, and established assumptions: only this assignment is exempt; accidental mutations of other event or systemPromptOptions properties still fail lint.
Review and revisit trigger: if Pi withdraws or changes the mutable-sections contract, replace the assignment with the supported replacement mechanism.
```

## QX-003: Fake-Pi boundary cast in the ask-question unit harness

```text
ID and title: QX-003 — fake-Pi boundary cast in the ask-question unit harness
Rule, option, or threshold; installed tool versions: typescript/no-unsafe-type-assertion; oxlint 1.90.0, oxlint-tsgolint 7.0.2005
Scope: tests/ask-question.test.ts, the single askQuestion(pi as unknown as ExtensionAPI) call that boots the real extension against the fake host
Directive selectors/inventory and optional duplication bounds: one next-line directive at the cast; no other site
Diagnostic and required contract: the local FakePi object implements the ExtensionAPI members askQuestion consumes (events, registerTool, registerCommand, on) with test-local return types. no-unsafe-type-assertion flags the unknown-to-narrower cast at the harness boundary.
Actual compliant alternative and demonstrated quality cost: a type guard proving every ExtensionAPI member on the fake would require reproducing the full SDK interface surface (dozens of members the extension never touches) in the test file, or wrapping the fake in a hand-rolled adapter implementing ExtensionAPI completely. Both add substantial harness machinery without strengthening what the 74 tests actually verify: the real extension code paths driven through the fake.
Chosen adjustment and why its scope is appropriate: next-line directive on the one boundary cast, identified QX-003. Every subsequent use of pi/events/tool inside the harness stays fully typed; the cast exists only to hand the fake to the real extension entry point.
Structural comparison or unsafe-type evidence, where applicable: the fake's members are structural subsets of ExtensionAPI members consumed by askQuestion (verified by the passing typecheck and tests); no unknown data crosses the boundary in the other direction.
Verification commands, relevant tests, and results: npm run typecheck (0 errors); npm test (74/74 in tests/ask-question.test.ts, driving the real extension through the fake); npx oxlint --deny-warnings tests/ask-question.test.ts (0 findings).
Retained protection, lost detection, and established assumptions: only this cast is exempt; any other unknown-to-narrower assertion in the harness still fails lint. Assumption: the fake remains a structural subset of the consumed API surface — a drift here fails tests, not lint.
Review and revisit trigger: if askQuestion starts consuming additional ExtensionAPI members, extend the fake (tests fail first); revisit if the SDK grows a supported test double.
```

## QX-004: Deliberately invalid bus payloads in the remote harness

```text
ID and title: QX-004 — deliberately invalid bus payloads in the remote harness
Rule, option, or threshold; installed tool versions: typescript/no-unsafe-type-assertion; oxlint 1.90.0, oxlint-tsgolint 7.0.2005
Scope: tests/ask-question.test.ts, the remote-harness start() call that feeds fuzzed remote-answer payloads to the real tool
Directive selectors/inventory and optional duplication bounds: one next-line directive on the params cast inside start(); no other site
Diagnostic and required contract: start(params: unknown, signal?) forwards arbitrary bus payloads as Static<typeof AskQuestionParams> to tool.execute. The payloads are deliberately malformed strings, arrays, and objects whose rejection is the behavior under test; execute's declared parameter type expects validated params.
Actual compliant alternative and demonstrated quality cost: no compliant alternative exists — the runtime guard being tested is normalize's schema validation inside the tool. A type guard that pre-validated the payloads would duplicate the production guard and make the rejection tests vacuous; passing only well-typed params would delete the tested behavior.
Chosen adjustment and why its scope is appropriate: next-line directive on the single cast, identified QX-004. All well-formed remote-answer events in the harness go through fully typed paths.
Structural comparison or unsafe-type evidence, where applicable: not applicable (intentional invalid inputs, not structure).
Verification commands, relevant tests, and results: npm run typecheck (0 errors); npm test (74/74, including the schema rejection test that proves invalid payloads are rejected at runtime); npx oxlint --deny-warnings tests/ask-question.test.ts (0 findings).
Retained protection, lost detection, and established assumptions: only this cast is exempt. Assumption: the production schema validation remains the actual guard — the schema rejection test failing would flag its erosion.
Review and revisit trigger: if the tool ever trusts params before normalize, or the schema rejection test is removed, re-evaluate.
```

## QX-005: node:test top-level registration allowance

```text
ID and title: QX-005 — node:test top-level registration allowance
Rule, option, or threshold; installed tool versions: typescript/no-floating-promises (allowForKnownSafeCalls, package specifier node:test / nodeTest); oxlint 1.90.0, oxlint-tsgolint 7.0.2005
Scope: .oxlintrc.json typescript/no-floating-promises allowForKnownSafeCalls; all test files' nodeTest(...) registrations imported as import { test as nodeTest } from "node:test"
Directive selectors/inventory and optional duplication bounds: one package-specifier entry { from: "package", package: "node:test", name: ["nodeTest"] }; no directives
Diagnostic and required contract: node:test's test() returns a Promise that resolves when the test completes, but the runner itself tracks completion and reports failures — awaiting registrations is not required for correctness and node:test's own docs show unawaited top-level test() calls. The strict rule flagged 47 unawaited registrations in tests/ask-question.test.ts alone.
Actual compliant alternative and demonstrated quality cost: awaiting every registration serializes test scheduling the runner is designed to handle concurrently and adds await noise to 49 registration sites; using .then/.catch per registration adds 49 handler stubs. The distinct nodeTest alias plus declaration-origin matching keeps the allowance precise where a plain "test" string specifier would also permit unsafe same-named calls.
Chosen adjustment and why its scope is appropriate: allowance matches the node:test package declaration named nodeTest only. All three test files import { test as nodeTest }, so the alias is the sole registration symbol; any other floating Promise still fails.
Structural comparison or unsafe-type evidence, where applicable: the six Section 6.4 controls, run against the actual installed declarations and imports with npx oxlint --deny-warnings on transient probe files (not committed): (1) unawaited top-level nodeTest(...) registration passes; (2) unawaited t.test(...) context subtest fails; (3) unawaited local Promise-returning function named nodeTest fails; (4) unawaited same-named import from another module fails; (5) floating Promise inside a test body fails; (6) unawaited unrelated Promise-returning call fails. All six produced the intended outcomes.
Verification commands, relevant tests, and results: npx oxlint --deny-warnings tests (0 findings); npm test (74/74 across the three test files).
Retained protection, lost detection, and established assumptions: floating Promises everywhere else — including context subtests, in-body promises, and same-named local or cross-module functions — remain detected, as the controls demonstrate. Assumption: the nodeTest alias remains used only for node:test registrations.
Review and revisit trigger: if a test file imports test without the alias, or oxlint changes specifier semantics, re-run the six controls.
```

## QX-006: Native-TUI probes of InteractiveMode private internals

```text
ID and title: QX-006 — native-TUI probes of InteractiveMode private internals
Rule, option, or threshold; installed tool versions: typescript/no-unsafe-type-assertion; oxlint 1.90.0, oxlint-tsgolint 7.0.2005
Scope: tests/native-tui.test.ts, the single modeInternals cast reaching InteractiveMode's private renderer and switchTuiMode members
Directive selectors/inventory and optional duplication bounds: one next-line directive on the mode as unknown as {...} declaration; no other site
Diagnostic and required contract: the native integration test asserts what the user sees (renderer mode, previousLines/previousScreen viewport slices) and switches fullscreen/regular — both are private members of InteractiveMode (renderer at dist/modes/interactive/interactive-mode.d.ts:44, switchTuiMode at :139 in the installed @earendil-works/pi-coding-agent). No public accessor or mode-switching API exists on the installed release, and the file's setup comment notes Pi's own native TUI tests use the same public Terminal injection and internal probing.
Actual compliant alternative and demonstrated quality cost: none available on the installed SDK. Dropping the probes would leave fullscreen/regular switching and viewport assertions untested; driving mode switches only through terminal byte sequences would not expose the viewport lines the assertions read.
Chosen adjustment and why its scope is appropriate: one directive on one const that names the probed internals explicitly (modeInternals); renderer()/viewport()/switchMode() helpers read from that single typed seam. Every other expression in the file stays fully typed.
Structural comparison or unsafe-type evidence, where applicable: the cast target lists exactly the two probed members with their shapes; if InteractiveMode's internals change, the runtime assertions fail first.
Verification commands, relevant tests, and results: npm run typecheck (0 errors); node --test tests/native-tui.test.ts (26/26 pass, including fullscreen/regular switching and viewport assertions); npx oxlint --deny-warnings tests/native-tui.test.ts (0 findings).
Retained protection, lost detection, and established assumptions: only this cast is exempt; the rest of the integration harness (typed MemoryTerminal, bus guards, ctx accessors) remains fully checked. Assumption: private renderer/switchTuiMode keep their current shapes — test failures flag drift.
Review and revisit trigger: if Pi publishes a public viewport or mode-switching API, replace the seam with it and drop this exception.
```
