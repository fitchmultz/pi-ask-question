# Development

[Back to the README](../README.md)

## Run locally

Requires Node.js 24+ and Pi 1.0.0+. Have `fd` and `rg` on PATH for native TUI initialization without downloads.

```bash
npm install --ignore-scripts
pi -e ./extensions/ask-question.ts
```

The publishable implementation is [`extensions/ask-question.ts`](../extensions/ask-question.ts). Use `/reload` after code changes; restart Pi after dependency or host-runtime changes.

## Check a change

```bash
npm run check:compat # all behavior tests + typecheck + pack dry-run
```

`check:compat` delegates to `npm run check`, which runs the behavior tests, TypeScript checking, and an npm pack dry-run. No production build or `prepare` is needed.

### Test coverage

- `tests/native-tui.test.ts` loads the extension through Pi's native SDK and runs `InteractiveMode` with an in-memory `Terminal`. It checks answer, Escape, and caller abort in default fullscreen and regular mode, short-terminal choices and editing, paging, resize, and widget overlap. It also checks draft and keyboard ownership restoration, cooperative answers and reload cleanup, and native grill-mode tree/fork/resume/reload restoration. It does not touch the process terminal or clipboard, use provider credentials, or make model calls.
- `tests/ask-question.test.ts` covers timeout, custom answers, multi-select, grill-mode, and the cooperative event-bus protocol.
- `tests/rpc-ui.test.ts` exercises actual bundled-CLI RPC selection, custom input, multi-select, cancellation, and reload recovery without provider calls.

Both default fullscreen and regular mode use the host renderer; no additional fork TUI APIs are required.

## Host compatibility

The lockfile is a reproducible development snapshot, not a release-qualification target. CI resolves the latest stable official Pi and the maintained fork's `main` commit once per run, then freezes those identities across tests, types, packing, and native Git/npm CLI checks.

Shared automation selects each host's actual SDK and companion dependency graph; tests resolve that selected host from the isolated checkout's `node_modules`. Runtime host peers remain wildcard as required by Pi packages. See [the compatibility workflow](../.github/workflows/pi-compatibility.yml) for the qualification steps.

## Publishing

The main-only [`npm-release.yml`](../.github/workflows/npm-release.yml) pipeline publishes intentional stable version bumps with nonempty versioned changelog notes only after both frozen host qualifications pass. Publishing stays off unless the repository variable `NPM_RELEASE_ENABLED` is `true`; release planning and publishing use the same host inputs.

A documentation-only change does not need a new package release. The package file allowlist excludes `docs/` and `.github/readme/`; the diagram source and PNG stay in the repository.

## README diagram

The editable source is [`.github/readme/question-flow.svg`](../.github/readme/question-flow.svg), with a rendered PNG alongside it. It shows the normal question/answer flow and the separate five-minute timeout. The rendering uses `rsvg-convert`; inspect the full image and a preview at GitHub's column width after editing the SVG.
