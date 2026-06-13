/**
 * Wave CS7 · Doc-reference validator — generalises the invariant firewall from
 * ~8 hand-picked kernels to EVERY machine-checkable claim in the live routing
 * docs. This is the piece that closes the "46% of prose claims stale" gap.
 *
 * It cannot check judgment ("this design is better because…") — nothing can.
 * But it checks every claim a machine CAN verify, across all live docs:
 *   HARD (fail the build):
 *     - markdown links to repo-relative paths must resolve to a real file/dir
 *     - backticked strings that are clearly file paths (have `/` + a code ext)
 *       must exist  → would have caught the phantom `scales.ts`
 *   WARN (surface, don't block — false-positive-prone):
 *     - `path#Lnn` line anchors (policy: never hand-type line numbers)
 *     - backticked code identifiers that appear NOWHERE in tracked source
 *       → would have caught the phantom `processUploadJob`
 *
 * SCOPE = live routing docs only. WAVES.md / docs/archive / docs/problems are
 * append-only history (they legitimately reference files that later moved), so
 * hard-checking them would be noise; they are excluded.
 *
 * CLI (`npm run check:doc-refs`) prints a report and exits 1 on any HARD miss.
 * Imported, `runDocRefChecks()` returns the structured findings (the
 * doc-refs.test.ts gate and the session-warmup hook reuse it).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

/** Live routing docs — excludes append-only history (WAVES/archive/problems). */
const DOC_GLOBS = [
  "CLAUDE.md",
  "docs/STATE.md",
  "docs/lessons.md",
  "docs/architecture",
  "docs/conventions",
  "docs/decisions",
  ".claude/skills",
];

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|json|ya?ml|sh|md|css)$/;

export interface DocFinding {
  doc: string;
  line: number;
  kind: "broken-link" | "broken-path" | "line-anchor" | "phantom-symbol";
  detail: string;
}

function sh(cmd: string): string {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** All markdown docs under the live globs (files + recursed dirs), repo-relative. */
function liveDocs(): string[] {
  const out = new Set<string>();
  for (const g of DOC_GLOBS) {
    const abs = join(REPO_ROOT, g);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      const listed = sh(`git ls-files -- "${g}"`).split("\n").filter((f) => f.endsWith(".md"));
      listed.forEach((f) => out.add(f));
    } else if (g.endsWith(".md")) {
      out.add(g);
    }
  }
  return [...out].sort();
}

function trackedFileSet(): Set<string> {
  return new Set(sh("git ls-files").split("\n").filter(Boolean));
}

/** Placeholder / glob / template tokens are not literal paths — never check them. */
function isTemplated(s: string): boolean {
  // placeholders, globs, ellipses, and ranges like `q01..q03.json` (dots between
  // word chars, distinct from `../` path-up which is dots-then-slash).
  return /[<>{}*$\s…]|\.\.\.|\.\.[^/]|YYYY|<n>|NNN/.test(s);
}

let _tracked: Set<string> | null = null;
function tracked(): Set<string> {
  return (_tracked ??= trackedFileSet());
}

/** A path resolves if it exists at repo root, OR any tracked file path ends with
 *  it (docs write deep-path shorthand like `runtime/schemas.ts` for
 *  `server/lib/agents/runtime/schemas.ts`). A ≥2-segment suffix is specific
 *  enough to stay low-false-positive while still catching true phantoms. */
function pathExistsAnyRoot(rel: string): boolean {
  const clean = rel.replace(/[#?].*$/, "").replace(/^(\.\.?\/)+/, "");
  // ESM (invariant #2) writes `.js` in imports though source is `.ts` — treat as equivalent.
  const variants = new Set([clean]);
  if (/\.js$/.test(clean)) variants.add(clean.replace(/\.js$/, ".ts"));
  if (/\.jsx$/.test(clean)) variants.add(clean.replace(/\.jsx$/, ".tsx"));
  for (const v of variants) {
    if (existsSync(join(REPO_ROOT, v))) return true;
    const suffix = "/" + v;
    for (const f of tracked()) if (f === v || f.endsWith(suffix)) return true;
  }
  return false;
}

function looksLikePath(s: string): boolean {
  return s.includes("/") && !isTemplated(s) && CODE_EXT.test(s.replace(/[#?].*$/, ""));
}

function looksLikeIdentifier(s: string): boolean {
  // camelCase or PascalCase, no separators, length > 3 — e.g. processUploadJob.
  return /^[A-Za-z][A-Za-z0-9]{3,}$/.test(s) && /[a-z][A-Z]|^[A-Z][a-z]/.test(s);
}

/** True if a markdown link target resolves (doc-dir, then root/suffix-match). */
function docLinkResolves(docRel: string, target: string): boolean {
  const clean = target.replace(/[#?].*$/, "");
  if (!clean) return true;
  if (existsSync(resolve(join(REPO_ROOT, dirname(docRel)), clean))) return true;
  return pathExistsAnyRoot(clean.replace(/^(\.\.\/)+/, ""));
}

function isExternal(target: string): boolean {
  return /^(https?:|mailto:|file:|tel:|#)/.test(target) || target.startsWith("/");
}

let _identifiers: Set<string> | null = null;
/** Lazily build the set of every identifier token in tracked source (for phantom-symbol warns). */
function sourceIdentifiers(): Set<string> {
  if (_identifiers) return _identifiers;
  const set = new Set<string>();
  const files = sh("git ls-files -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' '*.py'")
    .split("\n")
    .filter(Boolean);
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(REPO_ROOT, f), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) set.add(m[0]);
  }
  _identifiers = set;
  return set;
}

export function runDocRefChecks(): { hard: DocFinding[]; warn: DocFinding[] } {
  const hard: DocFinding[] = [];
  const warn: DocFinding[] = [];
  const candidateSymbols: { doc: string; line: number; sym: string }[] = [];

  for (const doc of liveDocs()) {
    const text = readFileSync(join(REPO_ROOT, doc), "utf8");
    const lines = text.split("\n");
    let inFence = false;
    lines.forEach((raw, i) => {
      const line = i + 1;
      if (/^\s*```/.test(raw)) {
        inFence = !inFence;
        return;
      }
      if (inFence) return; // fenced code = examples/templates, not live claims
      // markdown links [text](target)
      for (const m of raw.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = m[1]!.trim();
        if (isExternal(target) || isTemplated(target)) continue;
        if (!docLinkResolves(doc, target)) {
          hard.push({ doc, line, kind: "broken-link", detail: `→ ${target} (no such file)` });
        }
        if (/#L\d+/.test(target)) {
          hard.push({ doc, line, kind: "line-anchor", detail: `${target} — hand-typed line anchor (forbidden: rots silently, use a symbol ref)` });
        }
      }
      // backticked tokens
      for (const m of raw.matchAll(/`([^`]+)`/g)) {
        const tok = m[1]!.trim();
        if (looksLikePath(tok)) {
          if (!isExternal(tok) && !pathExistsAnyRoot(tok)) {
            hard.push({ doc, line, kind: "broken-path", detail: `\`${tok}\` (no such file)` });
          }
        } else if (looksLikeIdentifier(tok)) {
          candidateSymbols.push({ doc, line, sym: tok });
        }
      }
    });
  }

  if (candidateSymbols.length) {
    const ids = sourceIdentifiers();
    for (const c of candidateSymbols) {
      if (!ids.has(c.sym)) {
        warn.push({ doc: c.doc, line: c.line, kind: "phantom-symbol", detail: `\`${c.sym}\` not found anywhere in source (renamed/deleted?)` });
      }
    }
  }

  hard.sort((a, b) => a.doc.localeCompare(b.doc) || a.line - b.line);
  warn.sort((a, b) => a.doc.localeCompare(b.doc) || a.line - b.line);
  return { hard, warn };
}

function main(): void {
  const { hard, warn } = runDocRefChecks();
  console.log("Doc-reference validator — live routing docs vs. the tree\n");
  if (hard.length === 0) console.log("✓ No broken file references in live docs.");
  for (const f of hard) console.log(`✗ HARD ${f.doc}:${f.line} [${f.kind}] ${f.detail}`);
  if (warn.length) {
    console.log(`\n${warn.length} warning(s) (not blocking):`);
    for (const f of warn.slice(0, 60)) console.log(`  ⚠ ${f.doc}:${f.line} [${f.kind}] ${f.detail}`);
    if (warn.length > 60) console.log(`  … +${warn.length - 60} more`);
  }
  console.log(`\n${hard.length} hard failure(s), ${warn.length} warning(s).`);
  if (hard.length) {
    console.error(`\n✗ Live docs reference files that don't exist — fix the doc or the path.`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
