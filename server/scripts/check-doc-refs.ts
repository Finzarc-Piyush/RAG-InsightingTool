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
 *     - backticked ALL-CAPS_SNAKE tokens that LOOK like env vars (appear near
 *       the word "env" or in an env table) but are read by NO `process.env.X`
 *       / `getenv("X")` / `os.environ["X"]` anywhere in server + python-service
 *       → would catch a documented flag that was renamed/deleted in code
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
  kind: "broken-link" | "broken-path" | "line-anchor" | "phantom-symbol" | "phantom-env";
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

/** Library types/values legitimately named in docs but defined outside our source. */
const EXTERNAL_LIB = new Set(["FeedOptions", "Bisector", "SqlQuerySpec", "ItemResponse"]);

/** Skip phantom-symbol warnings for JS/Web builtins (on globalThis) and known
 *  external library symbols — they're real, just not in our tree. */
function isExternalIdentifier(s: string): boolean {
  return s in globalThis || EXTERNAL_LIB.has(s);
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

let _envNames: Set<string> | null = null;
/** Lazily build the set of every env-var name actually READ in code, by grepping
 *  `process.env.X` (Node) + `getenv("X")` / `os.environ["X"]` (Python) across
 *  server + python-service, plus client `import.meta.env.VITE_*` (so legitimately
 *  documented client env vars aren't flagged). This is the ground truth the
 *  phantom-env WARN compares documented env-looking tokens against. */
function sourceEnvNames(): Set<string> {
  if (_envNames) return _envNames;
  const set = new Set<string>();
  const add = (raw: string, re: RegExp) => {
    for (const m of raw.matchAll(re)) set.add(m[1]!);
  };
  // Node `process.env.X` + client `import.meta.env.X` reads.
  for (const f of sh("git ls-files -- 'server' 'python-service' 'client' 'api'").split("\n").filter(Boolean)) {
    let text: string;
    try {
      text = readFileSync(join(REPO_ROOT, f), "utf8");
    } catch {
      continue;
    }
    add(text, /process\.env\.([A-Z][A-Z0-9_]+)/g);
    add(text, /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g);
    // Python `os.getenv("X")` / `os.environ["X"]` / `os.environ.get("X")`.
    add(text, /getenv\(\s*["']([A-Z][A-Z0-9_]+)["']/g);
    add(text, /environ(?:\.get)?\(?\s*\[?\s*["']([A-Z][A-Z0-9_]+)["']/g);
  }
  _envNames = set;
  return set;
}

/** A backticked ALL-CAPS_SNAKE token (≥5 chars, underscore-or-digit body). These
 *  are the env-flag shape (`AGENTIC_LOOP_ENABLED`); they never match the camelCase
 *  `looksLikeIdentifier`, so the symbol check ignores them — env is their only gate. */
function looksLikeEnvVar(s: string): boolean {
  return /^[A-Z][A-Z0-9_]{4,}$/.test(s) && s.includes("_") && !isTemplated(s);
}

/** Heuristic "this token is being used as an env var here": the line mentions
 *  env/environment/`.env`, OR it's a markdown table row inside an env-themed doc
 *  (e.g. `ci-and-env.md`'s flag table lists one var per row without repeating the
 *  word "env"). Restricting the table signal to env-named docs keeps non-env
 *  constant tables (e.g. charting.md's "Constants" table) from matching. Low-recall
 *  on purpose — a WARN tier exists to surface likely rot, not to fire on every
 *  shouty constant. */
function inEnvContext(rawLine: string, docRel: string): boolean {
  if (/\benv(ironment)?\b/i.test(rawLine) || /\.env\b/i.test(rawLine)) return true;
  return /env/i.test(docRel) && /^\s*\|/.test(rawLine);
}

export function runDocRefChecks(): { hard: DocFinding[]; warn: DocFinding[] } {
  const hard: DocFinding[] = [];
  const warn: DocFinding[] = [];
  const candidateSymbols: { doc: string; line: number; sym: string }[] = [];
  const candidateEnvVars: { doc: string; line: number; name: string }[] = [];

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
      // hand-typed `file.ext:NNN` line refs in prose / link text — same rot class
      // as #L anchors (8/8 sampled were stale). Forbidden: name the symbol instead.
      for (const m of raw.matchAll(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py):\d+(?:-\d+)?/g)) {
        hard.push({ doc, line, kind: "line-anchor", detail: `${m[0]} — hand-typed line number (forbidden: rots; use the symbol name + docs/index/symbols.generated.tsv)` });
      }
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
        } else if (looksLikeEnvVar(tok) && inEnvContext(raw, doc)) {
          candidateEnvVars.push({ doc, line, name: tok });
        }
      }
    });
  }

  if (candidateSymbols.length) {
    const ids = sourceIdentifiers();
    for (const c of candidateSymbols) {
      if (isExternalIdentifier(c.sym)) continue;
      if (!ids.has(c.sym)) {
        warn.push({ doc: c.doc, line: c.line, kind: "phantom-symbol", detail: `\`${c.sym}\` not found anywhere in source (renamed/deleted?)` });
      }
    }
  }

  if (candidateEnvVars.length) {
    const envNames = sourceEnvNames();
    const ids = sourceIdentifiers();
    const seen = new Set<string>();
    for (const c of candidateEnvVars) {
      if (envNames.has(c.name)) continue;
      // A token that exists as a real source identifier is a documented CONSTANT,
      // not a phantom env var (e.g. `LINE_AREA_MAX_X_TICKS`, `EXPORT_BRAND`). The
      // symbol check already vouches for it — env is only the gate for tokens that
      // appear NOWHERE in code, in any form.
      if (ids.has(c.name)) continue;
      const key = `${c.doc}:${c.line}:${c.name}`;
      if (seen.has(key)) continue; // de-dupe a token repeated on one line
      seen.add(key);
      warn.push({ doc: c.doc, line: c.line, kind: "phantom-env", detail: `\`${c.name}\` looks like an env var but is read by no process.env/getenv/os.environ in server+python-service (renamed/deleted?)` });
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
