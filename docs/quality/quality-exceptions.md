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
Scope: extensions/lib/grill-me.ts, the before_agent_start handler's grill_me section assignment
Directive selectors/inventory and optional duplication bounds: one next-line directive on the sections assignment; no other site
Diagnostic and required contract: event.systemPromptOptions.sections.grill_me = guidance assigns to a property of the event parameter. The Pi SDK documents this as the supported contract: "Mutable prompt sections. Later handlers observe mutations made by earlier handlers." (BeforeAgentStartEventBase.systemPromptOptions, @earendil-works/pi-coding-agent dist/core/extensions/types.d.ts). Section injection is the intended mechanism for augmenting the composed system prompt.
Actual compliant alternative and demonstrated quality cost: returning BeforeAgentStartEventResult with a full systemPrompt string replaces the entire composed prompt rather than adding one section, and would require this repository to duplicate Pi's prompt assembly to preserve unrelated sections. The handler already uses the return path where the SDK requires it (forceSystemPrompt is set).
Chosen adjustment and why its scope is appropriate: next-line eslint/no-param-reassign directive on the single documented-mutation assignment, identified QX-002. All other parameter assignments remain enforced.
Structural comparison or unsafe-type evidence, where applicable: not applicable (documented mutable contract, not structure).
Verification commands, relevant tests, and results: npm run typecheck (0 errors); npm test (74/74 pass, including grill-me section injection assertions on systemPromptOptions.sections["grill_me"] in tests/ask-question.test.ts); npx oxlint --deny-warnings extensions (0 findings).
Retained protection, lost detection, and established assumptions: only this assignment is exempt; accidental mutations of other event or systemPromptOptions properties still fail lint.
Review and revisit trigger: if Pi withdraws or changes the mutable-sections contract, replace the assignment with the supported replacement mechanism.
```
