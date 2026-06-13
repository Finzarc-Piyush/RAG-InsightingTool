/**
 * Wave W1 · The invariant firewall.
 *
 * Executes the machine-checkable kernel of each CLAUDE.md invariant
 * (server/scripts/invariants.spec.ts) against the live tree and reports
 * pass/fail. Run directly (`npm run check:invariants`) it prints a table and
 * exits non-zero on any failure; imported, `runInvariantChecks()` returns the
 * structured results (the invariants.test.ts gate and the BOOTSTRAP generator
 * reuse it). A failing check means CLAUDE.md is about to mislead a fresh Claude
 * session — fix the code, or update the invariant SoT if the truth changed.
 *
 * No external deps: file reads + regex + JSON.parse, matching the repo's
 * tsx-script convention (cf. scripts/build-domain-packs.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { INVARIANTS } from "./invariants.spec.js";
import type { Check } from "./invariants.spec.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // server/scripts
const REPO_ROOT = join(HERE, "..", ".."); // → repo root

export interface CheckResult {
  invariantId: string;
  title: string;
  ok: boolean;
  /** Human description of the check; on failure, appended with the reason. */
  detail: string;
}

function readRel(rel: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, rel), "utf8");
  } catch {
    return null;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matches(text: string, needle: string | RegExp): boolean {
  return typeof needle === "string" ? text.includes(needle) : needle.test(text);
}

function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/** Module specifier of the first non-comment import statement, or null. */
function firstImportModule(text: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (
      !line ||
      line.startsWith("//") ||
      line.startsWith("/*") ||
      line.startsWith("*")
    ) {
      continue;
    }
    const m = line.match(/^import\b[^"']*["']([^"']+)["']/);
    if (m) return m[1];
    return null; // first meaningful line is not an import → no leading import
  }
  return null;
}

function describe(check: Check): string {
  switch (check.kind) {
    case "file_contains":
      return `${check.file} contains ${JSON.stringify(String(check.needle))}`;
    case "absent":
      return `${check.file} omits ${JSON.stringify(String(check.needle))}`;
    case "json_eq":
      return `${check.file} :: ${check.path} === ${JSON.stringify(check.equals)}`;
    case "first_import":
      return `${check.file} first import is "${check.module}"`;
    case "symbol_exported":
      return `${check.file} exports ${check.symbol}`;
  }
}

function evalCheck(check: Check): { ok: boolean; reason: string } {
  if (check.kind === "json_eq") {
    const raw = readRel(check.file);
    if (raw === null) return { ok: false, reason: `file missing` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, reason: `invalid JSON (${(e as Error).message})` };
    }
    const actual = getByPath(parsed, check.path);
    const ok = JSON.stringify(actual) === JSON.stringify(check.equals);
    return { ok, reason: ok ? "" : `got ${JSON.stringify(actual)}` };
  }

  const text = readRel(check.file);
  if (text === null) return { ok: false, reason: `file missing` };

  switch (check.kind) {
    case "file_contains": {
      const ok = matches(text, check.needle);
      return { ok, reason: ok ? "" : "needle not found" };
    }
    case "absent": {
      const ok = !matches(text, check.needle);
      return { ok, reason: ok ? "" : "forbidden needle present (contradiction)" };
    }
    case "first_import": {
      const mod = firstImportModule(text);
      const ok = mod === check.module;
      return { ok, reason: ok ? "" : `first import is "${mod ?? "(none)"}"` };
    }
    case "symbol_exported": {
      const re = new RegExp(
        `export\\s+(?:default\\s+)?(?:async\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${escapeRe(
          check.symbol
        )}\\b`
      );
      const ok = re.test(text);
      return { ok, reason: ok ? "" : "no top-level export found" };
    }
  }
}

/** Run every invariant's checks against the tree. One CheckResult per check. */
export function runInvariantChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  for (const inv of INVARIANTS) {
    for (const check of inv.checks) {
      const { ok, reason } = evalCheck(check);
      results.push({
        invariantId: inv.id,
        title: inv.title,
        ok,
        detail: ok ? describe(check) : `${describe(check)} — ${reason}`,
      });
    }
  }
  return results;
}

function main(): void {
  const results = runInvariantChecks();
  const byInv = new Map<string, CheckResult[]>();
  for (const r of results) {
    const arr = byInv.get(r.invariantId) ?? [];
    arr.push(r);
    byInv.set(r.invariantId, arr);
  }

  console.log("Invariant firewall — CLAUDE.md kernels vs. the live tree\n");
  for (const [id, rs] of byInv) {
    const invOk = rs.every((r) => r.ok);
    console.log(`${invOk ? "✓" : "✗"} ${id}  ${rs[0]!.title}`);
    for (const r of rs) console.log(`    ${r.ok ? "·" : "✗"} ${r.detail}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed across ${byInv.size} invariants.`
  );
  if (failed.length) {
    console.error(
      `\n✗ ${failed.length} invariant check(s) FAILED — CLAUDE.md would mislead a fresh session.\n` +
        `  Fix the code, or update the invariant SoT (server/scripts/invariants.spec.ts) if the truth changed.`
    );
    process.exit(1);
  }
  console.log("✓ All invariants hold — CLAUDE.md matches the tree.");
}

// CLI entry only when executed directly (not when imported by the test/generator).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
