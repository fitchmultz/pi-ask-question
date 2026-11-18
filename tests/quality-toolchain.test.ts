import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test as nodeTest } from "node:test";

const repo = resolve(import.meta.dirname, "..");

function createTempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-ask-toolchain-"));
  for (const file of [".oxlintrc.json", "tsconfig.json"]) {
    cpSync(join(repo, file), join(root, file));
  }
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
  mkdirSync(join(root, "extensions"), { recursive: true });
  return root;
}

nodeTest(
  "tsrs type-aware rules, missing-backend fail-closed guard, and canonical tsc 7.0.2 stay active",
  () => {
    const root = createTempProject();
    try {
      const probePath = join(root, "extensions", "toolchain-probe.ts");
      writeFileSync(
        probePath,
        [
          "export async function work(): Promise<void> {",
          "  await Promise.resolve();",
          "}",
          "work();",
          "function run(cb: () => void): void {",
          "  cb();",
          "}",
          "run(async () => {",
          "  await Promise.resolve();",
          "});",
          "export function readUnsafe(raw: string): number {",
          "  const parsed = JSON.parse(raw);",
          "  return parsed.x;",
          "}",
          "const broad: Record<string, unknown> = { k: 1 };",
          "export const narrowed = broad as { k: number };",
          "export async function badReject(): Promise<unknown> {",
          '  return Promise.reject("boom");',
          "}",
          "",
        ].join("\n"),
      );

      const oxlintBin = join(repo, "node_modules", ".bin", "oxlint");
      const lint = spawnSync(oxlintBin, ["--format=json", "extensions/toolchain-probe.ts"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.notEqual(lint.status, 0, "type-aware probes must fail under tsrs");
      const parsed: unknown = JSON.parse(lint.stdout === "" ? "{}" : lint.stdout);
      assert.ok(
        typeof parsed === "object" &&
          parsed !== null &&
          "diagnostics" in parsed &&
          Array.isArray(parsed.diagnostics),
      );
      const codes = new Set(
        parsed.diagnostics.map((entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          "code" in entry &&
          typeof entry.code === "string"
            ? entry.code
            : "",
        ),
      );
      for (const expected of [
        "typescript(no-floating-promises)",
        "typescript(no-misused-promises)",
        "typescript(no-unsafe-member-access)",
        "typescript(no-unsafe-type-assertion)",
        "typescript(prefer-promise-reject-errors)",
      ]) {
        assert.ok(codes.has(expected), `missing ${expected} in ${JSON.stringify([...codes])}`);
      }

      writeFileSync(probePath, "export const ok = 1;\n");
      const clean = spawnSync(oxlintBin, ["--deny-warnings", "extensions/toolchain-probe.ts"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(
        clean.status,
        0,
        `clean probe must pass under tsrs: ${clean.stdout}${clean.stderr}`,
      );

      const missing = spawnSync(oxlintBin, ["--deny-warnings", "extensions/toolchain-probe.ts"], {
        cwd: root,
        env: { ...process.env, OXLINT_TSGOLINT_PATH: join(root, "missing-tsrs-lint") },
        encoding: "utf8",
      });
      assert.notEqual(missing.status, 0, "missing type-aware backend must fail closed");
      assert.match(`${missing.stdout}${missing.stderr}`, /Failed to find tsgolint executable/i);

      writeFileSync(
        probePath,
        'export const invalidAssignment: number = "not-a-number";\nconsole.log(invalidAssignment);\n',
      );
      const tsc = spawnSync(join(repo, "node_modules", ".bin", "tsc"), ["--noEmit"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.notEqual(tsc.status, 0, "canonical tsc 7.0.2 must fail independently on type errors");
      assert.match(`${tsc.stdout}${tsc.stderr}`, /TS2322/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
