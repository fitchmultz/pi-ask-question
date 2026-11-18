# Quality-exception record

Quality exceptions under [the Strict Oxlint and Oxfmt Engineering Standard](../strict-oxlint-oxfmt-standard.md), Section 2. Each entry uses the Appendix B record format with a stable identifier.

## QX-001: Five-parameter `execute` callback for `ask_question`

```text
ID and title: QX-001 — five-parameter execute callback for ask_question
Rule, option, or threshold; installed tool versions: eslint/max-params (max 4); oxlint 1.94.0, tsrs 7.1.0-beta.tsrs2
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
Rule, option, or threshold; installed tool versions: eslint/no-param-reassign (props); oxlint 1.94.0, tsrs 7.1.0-beta.tsrs2
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
Rule, option, or threshold; installed tool versions: typescript/no-unsafe-type-assertion; oxlint 1.94.0, tsrs 7.1.0-beta.tsrs2
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
Rule, option, or threshold; installed tool versions: typescript/no-unsafe-type-assertion; oxlint 1.94.0, tsrs 7.1.0-beta.tsrs2
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
Rule, option, or threshold; installed tool versions: typescript/no-floating-promises (allowForKnownSafeCalls, package specifier node:test / nodeTest); oxlint 1.94.0, tsrs 7.1.0-beta.tsrs2
Scope: .oxlintrc.json typescript/no-floating-promises allowForKnownSafeCalls; all test files' nodeTest(...) registrations imported as import { test as nodeTest } from "node:test"
Directive selectors/inventory and optional duplication bounds: one package-specifier entry { from: "package", package: "node:test", name: ["nodeTest"] }; no directives
Diagnostic and required contract: node:test's test() returns a Promise that resolves when the test completes, but the runner itself tracks completion and reports failures — awaiting registrations is not required for correctness and node:test's own docs show unawaited top-level test() calls. The strict rule flagged 47 unawaited registrations in tests/ask-question.test.ts alone.
Actual compliant alternative and demonstrated quality cost: awaiting every registration serializes test scheduling the runner is designed to handle concurrently and adds await noise to 49 registration sites; using .then/.catch per registration adds 49 handler stubs. The distinct nodeTest alias plus declaration-origin matching keeps the allowance precise where a plain "test" string specifier would also permit unsafe same-named calls.
Chosen adjustment and why its scope is appropriate: allowance matches the node:test package declaration named nodeTest only. All three test files import { test as nodeTest }, so the alias is the sole registration symbol; any other floating Promise still fails.
Structural comparison or unsafe-type evidence, where applicable: the six Section 6.4 controls, requalified 2026-11-18 against oxlint 1.94.0 + tsrs 7.1.0-beta.tsrs2 + @types/node 24.19.1 with ./node_modules/.bin/oxlint --deny-warnings on transient probes in tests/ (not committed): (1) unawaited top-level nodeTest(...) registration passes (exit 0); (2) unawaited t.test(...) context subtest fails (exit 1); (3) unawaited local async function nodeTest fails (exit 1); (4) unawaited same-named import from a local helper module fails (exit 1); (5) floating Promise inside a test body fails (exit 1); (6) unawaited unrelated Promise-returning call fails (exit 1). All six produced the intended outcomes.
Verification commands, relevant tests, and results: npm run lint (0 findings across repo); npm test (passes across tests/*.test.ts).
Retained protection, lost detection, and established assumptions: floating Promises everywhere else — including context subtests, in-body promises, and same-named local or cross-module functions — remain detected, as the controls demonstrate. Assumption: the nodeTest alias remains used only for node:test registrations.
Review and revisit trigger: if a test file imports test without the alias, or oxlint changes specifier semantics, re-run the six controls.
```

## QX-006: Native-TUI probes of InteractiveMode private internals

```text
ID and title: QX-006 — native-TUI probes of InteractiveMode private internals
Rule, option, or threshold; installed tool versions: typescript/no-unsafe-type-assertion; oxlint 1.94.0, tsrs 7.1.0-beta.tsrs2
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

## QX-007: Return cast of the `prepareArguments` hook

```text
ID and title: QX-007 — return cast of the prepareArguments hook
Rule, option, or threshold; installed tool versions: typescript/no-unsafe-type-assertion; oxlint 1.94.0, tsrs 7.1.0-beta.tsrs2
Scope: extensions/lib/schema.ts, the single return of prepareAskQuestionArguments
Directive selectors/inventory and optional duplication bounds: one next-line directive on that return statement; no other site
Diagnostic and required contract: prepareAskQuestionArguments returns the model's raw arguments, with JSON list strings read as lists, as Static<typeof AskQuestionParams>. The Pi SDK types the hook as prepareArguments?: (args: unknown) => Static<TParams> (@earendil-works/pi-coding-agent dist/core/extensions/types.d.ts:490), but it runs before validation: "If defined, it runs before schema validation and before execute() ... Return the object you want validated against parameters" (docs/extensions.md:2302). Pi validates the returned value itself (pi-agent-core dist/agent-loop.js:478 then :498). The value is unvalidated by design, so no type guard can prove the declared return type.
Actual compliant alternative and demonstrated quality cost: validating inside the hook to earn the type would duplicate Pi's conversion and validation, and would have to reject or rewrite arguments that Pi converts today (multiSelect "false", a plain text option), changing tool behavior. Parsing inside execute instead runs after Pi has already wrapped the string into a one-item list. Pi's own documentation example and its edit tool use the same cast (docs/extensions.md:2226-2233; dist/core/tools/edit.js:41-70).
Chosen adjustment and why its scope is appropriate: one next-line directive on the one return, identified QX-007. All list reading before it works on unknown values with real checks (isRecord, typeof, Array.isArray).
Structural comparison or unsafe-type evidence, where applicable: the cast value reaches only two consumers. Pi validates it before execute. The call renderer passes it to normalize, which receives raw model arguments from Pi's renderCall contract with or without this hook.
Verification commands, relevant tests, and results: npm run typecheck (0 errors); npm test (90/90 pass, including the bundled-CLI cases in tests/rpc-ui.test.ts where a model sends list strings through Pi's preparation and validation); npx oxlint --deny-warnings . (0 findings).
Retained protection, lost detection, and established assumptions: only this return is exempt; any other unknown-to-narrower assertion still fails lint. Assumption: Pi keeps validating the hook's return value. The bundled-CLI tests fail if it stops.
Review and revisit trigger: if the Pi SDK types the hook's return as unvalidated input, drop the cast and this exception.
```

## QX-008: Prerelease `tsrs` type-aware backend in place of stable `oxlint-tsgolint`

```text
ID and title: QX-008 — adopt prerelease tsrs@7.1.0-beta.tsrs2 as the type-aware lint backend in place of stable oxlint-tsgolint
Rule, option, or threshold; installed tool versions: Standard §5.1 ("latest stable published releases of Oxlint, oxlint-tsgolint, Oxfmt"); oxlint 1.94.0 (2026-11-16T12:26Z), tsrs 7.1.0-beta.tsrs2 (2026-11-16T11:59Z), oxfmt 0.79.0 (2026-11-16T12:27Z), typescript 7.0.2
Scope: package.json / package-lock.json devDependencies and type-aware lint execution across the repository (oxlint discovers node_modules/.bin/tsrs-lint natively)
Directive selectors/inventory and optional duplication bounds: none; backend package substitution only (QX-001 through QX-007 inventories stay unchanged)
Diagnostic and required contract: Standard §5.1 asks for stable published releases, whereas tsrs publishes prereleases only (dist-tags.latest is 0.25.0-ts7.1.0-beta; 7.1.0-beta.tsrs2 is an untagged newer prerelease; stable oxlint-tsgolint 7.0.2007 remains published on npm).
Actual compliant alternative and demonstrated quality cost: keeping stable oxlint-tsgolint@7.0.2007 satisfies §5.1 literally. In a matched A/B benchmark on mitchs-m5-mbp (Darwin arm64, oxlint 1.94.0 running `oxlint --deny-warnings .`, median of 3 warm runs each via OXLINT_TSGOLINT_PATH), oxlint-tsgolint@7.0.2007 took 0.37s wall time and 422.2 MiB maximum RSS vs 0.15s wall time and 205.7 MiB maximum RSS with tsrs@7.1.0-beta.tsrs2 (2.47x slower, 2.05x / 216.5 MiB higher peak RSS; both exited 0).
Chosen adjustment and why its scope is appropriate: owner-approved substitution of tsrs@7.1.0-beta.tsrs2; oxlint 1.94.0 discovers tsrs-lint automatically and fails closed (exit 1) when no backend executable exists. All Appendix A type-aware rules and canonical tsc 7.0.2 compiler checks stay intact.
Structural comparison or unsafe-type evidence, where applicable: verified by requalifying the six QX-005 §6.4 controls, a matched 7-diagnostic parity probe (identical diagnostics on exact lines under both oxlint-tsgolint@7.0.2007 and tsrs@7.1.0-beta.tsrs2), and tests/quality-toolchain.test.ts (which verifies tsrs reports typescript(no-floating-promises), typescript(no-misused-promises), typescript(no-unsafe-member-access), typescript(no-unsafe-type-assertion), and typescript(prefer-promise-reject-errors), fails closed without tsrs-lint, and verifies canonical tsc 7.0.2 independently rejects TS2322 despite tsrs bundling typescriptVersion 7.1.0-beta).
Verification commands, relevant tests, and results: npm run check / npm run check:compat (oxlint --deny-warnings ., node --test tests/*.test.ts including tests/quality-toolchain.test.ts, tsc --noEmit, oxfmt --check ., npm pack --dry-run) exits 0 on 2026-11-18.
Retained protection, lost detection, and established assumptions: all type-aware rules, QX-001..QX-007 safeguards, and canonical tsc 7.0.2 compiler checks remain active and directly tested by tests/quality-toolchain.test.ts and npm run check.
Review and revisit trigger: first stable tsrs release, any oxlint release changing backend discovery, or any type-aware diagnostic regression.
```
