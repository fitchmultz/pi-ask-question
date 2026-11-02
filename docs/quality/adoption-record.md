# Adoption record

## Repository

- Repository: `fitchmultz/pi-ask-question`
- Adopted standard: [Strict Oxlint and Oxfmt Engineering Standard](../strict-oxlint-oxfmt-standard.md), version 5.1.2 (1 November 2026)
- Supported runtimes: Node.js 24 or newer (`.nvmrc` pins 24.21.0); npm 12 (`packageManager: npm@12.2.0`)
- Starting revision: `78651db` on `main`, clean working tree; the unrelated `docs/dependency-maintenance-20261017` branch and its worktrees are separate in-flight work and are not part of this migration

## Installed toolchain

| Tool                            | Version  |
| ------------------------------- | -------- |
| oxlint                          | 1.90.0   |
| oxlint-tsgolint                 | 7.0.2005 |
| oxfmt                           | 0.75.0   |
| typescript (canonical compiler) | 7.0.2    |

## Configuration and acceptance paths

| Check     | Configuration                                                  | Command                                     |
| --------- | -------------------------------------------------------------- | ------------------------------------------- |
| Lint      | [`.oxlintrc.json`](../../.oxlintrc.json) (Appendix A baseline) | `npm run lint` (`oxlint --deny-warnings .`) |
| Format    | [`.oxfmtrc.json`](../../.oxfmtrc.json) (Section 7.1 defaults)  | `npm run format:check` / `npm run format`   |
| Compiler  | [`tsconfig.json`](../../tsconfig.json) (Section 4.2 options)   | `npm run typecheck`                         |
| Tests     | node:test                                                      | `npm test`                                  |
| Aggregate |                                                                | `npm run check`                             |

Hosted CI runs a `quality` job (format, tests, typecheck, and once enforcement completes, lint) and the `compatibility` job (host qualification) on every pull request and main push in [`pi-compatibility.yml`](../../.github/workflows/pi-compatibility.yml).

## Source profiles and formatter ownership

| Profile    | Files                                               |
| ---------- | --------------------------------------------------- |
| Production | `extensions/ask-question.ts`, `extensions/lib/*.ts` |
| Tests      | `tests/*.test.ts`                                   |

The repository contains no handwritten declarations, no maintained JavaScript, no generated or vendored output, and no generators, so declaration checking, generated-freshness checks, and separate formatter ownership do not apply. oxfmt owns every supported maintained file (TypeScript, Markdown, YAML, JSON). The canonical compiler project covers both profiles through `tsconfig.json`.

## Migration status

Phased enforcement under standard Section 9.2. Each phase lands only when its declared scope passes the strict checks.

| Phase                                                       | Status  |
| ----------------------------------------------------------- | ------- |
| Toolchain, baseline config, formatting, compiler strictness | Done    |
| Source lint compliance (`extensions/`)                      | Pending |
| Test lint compliance and repository-wide lint enforcement   | Pending |

## Verification

| Revision    | Scope                                                                                               | Result                            |
| ----------- | --------------------------------------------------------------------------------------------------- | --------------------------------- |
| this change | `npm test` (74 passing), `npm run typecheck` (0 errors), `npm run format:check` (clean, idempotent) | Passed locally; hosted CI pending |
