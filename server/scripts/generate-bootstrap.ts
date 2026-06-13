/**
 * Wave CS2 · On-demand orient pack generator.
 *
 * Prints a compact, ALWAYS-CURRENT warmup pack to stdout: live git state, the
 * invariant-firewall verdict (reuses runInvariantChecks from CS1), recent churn
 * + inferred active subsystem, WIP/plan, a doc size+freshness table, and recent
 * lesson titles. Run by the /orient skill via `npm run orient`. Nothing is
 * committed — the pack is recomputed every session, so it can never go stale
 * (the failure mode that left STATE.md 62 commits behind on the wrong branch).
 *
 * All git calls are wrapped: a shallow CI clone (no origin/main, no HEAD~5)
 * degrades gracefully instead of throwing.
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runInvariantChecks } from "./check-invariants.js";
import {
  assembleBootstrap,
  estimateTokens,
  type BootstrapInput,
  type DocEntry,
  type LessonHead,
  type RecentCommit,
} from "./lib/bootstrapSections.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // server/scripts
const REPO_ROOT = join(HERE, "..", ".."); // repo root
const PLANS_DIR = "/Users/tida/.claude/plans";
const TOKEN_WARN = 3500;

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function gitOrNull(args: string): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function readRel(rel: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, rel), "utf8");
  } catch {
    return null;
  }
}

function invariantSummary() {
  const results = runInvariantChecks();
  const failures = results.filter((r) => !r.ok).map((r) => `${r.invariantId}: ${r.detail}`);
  return { passed: results.length - failures.length, total: results.length, failures };
}

function recentCommits(): RecentCommit[] {
  const raw = gitOrNull("log -12 --format=%h%x09%s") ?? "";
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, ...rest] = line.split("\t");
      return { hash: hash!, subject: rest.join("\t") };
    });
}

function churnedFiles(): string[] {
  const raw = gitOrNull("diff --name-only HEAD~5..HEAD") ?? gitOrNull("diff --name-only HEAD~1..HEAD") ?? "";
  return raw.split("\n").filter(Boolean);
}

function newestPlanTitle(): string | null {
  let entries: string[];
  try {
    entries = readdirSync(PLANS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }
  let newest: { path: string; mtime: number } | null = null;
  for (const f of entries) {
    const p = join(PLANS_DIR, f);
    try {
      const mtime = statSync(p).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path: p, mtime };
    } catch {
      /* skip */
    }
  }
  if (!newest) return null;
  try {
    const first = readFileSync(newest.path, "utf8").split("\n").find((l) => l.startsWith("# "));
    return first ? first.replace(/^#\s*/, "") : newest.path.split("/").pop()!;
  } catch {
    return null;
  }
}

/** Best-effort: the durable "live streams" block from STATE.md, if present. */
function streamsFromState(): string | null {
  const text = readRel("docs/STATE.md");
  if (!text) return null;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^#{1,3}\s.*stream/i.test(l));
  if (start === -1) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  const body = out.join("\n").trim();
  return body || null;
}

function docEntries(): DocEntry[] {
  const fixed = ["CLAUDE.md", "docs/STATE.md", "docs/WAVES.md", "docs/lessons.md"];
  let arch: string[] = [];
  try {
    arch = readdirSync(join(REPO_ROOT, "docs/architecture"))
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .map((f) => `docs/architecture/${f}`)
      .sort();
  } catch {
    /* none */
  }
  const out: DocEntry[] = [];
  for (const path of [...fixed, ...arch]) {
    const text = readRel(path);
    if (text == null) continue;
    const lastTouched = gitOrNull(`log -1 --format=%cs -- "${path}"`) ?? "?";
    out.push({ path, tokens: estimateTokens(text), lastTouched });
  }
  return out;
}

function lessonHeads(): LessonHead[] {
  const text = readRel("docs/lessons.md");
  if (!text) return [];
  const out: LessonHead[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^##\s+(L-\d+)\s+[—-]\s+(.+)$/);
    if (m) out.push({ id: m[1]!, title: m[2]!.trim() });
  }
  return out;
}

function main(): void {
  const input: BootstrapInput = {
    git: {
      branch: gitOrNull("rev-parse --abbrev-ref HEAD") ?? "?",
      headShort: gitOrNull("rev-parse --short HEAD") ?? "?",
      headSubject: gitOrNull("log -1 --format=%s") ?? "?",
      dirtyCount: (gitOrNull("status --porcelain") ?? "").split("\n").filter(Boolean).length,
      commitsSinceMain: (() => {
        const n = gitOrNull("rev-list --count origin/main..HEAD");
        return n == null ? null : Number(n);
      })(),
      newestDateRel: gitOrNull("log -1 --format=%cr") ?? "?",
    },
    recentCommits: recentCommits(),
    churnedFiles: churnedFiles(),
    planTitle: newestPlanTitle(),
    streams: streamsFromState(),
    invariants: invariantSummary(),
    docs: docEntries(),
    lessons: lessonHeads(),
    generatedNote: `generated by \`npm run orient\` — recomputed fresh each session, never committed`,
  };

  const pack = assembleBootstrap(input);
  process.stdout.write(pack + "\n");
  const tokens = estimateTokens(pack);
  if (tokens > TOKEN_WARN) {
    process.stderr.write(`\n⚠ orient pack ~${tokens} tokens (>${TOKEN_WARN}); consider trimming sections.\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
