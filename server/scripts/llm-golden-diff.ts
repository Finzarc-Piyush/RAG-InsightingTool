/**
 * W3.11 · Diff two replay-result files produced by `llm-golden-replay.ts`.
 *
 * Usage:
 *   npx tsx server/scripts/llm-golden-diff.ts baseline candidate
 *
 * Prints a summary table + per-question deltas. Exits non-zero when the
 * candidate has any new error/timeout the baseline didn't have, so this can
 * gate a CI step before bumping a model-routing ramp.
 */

import "../loadEnv.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RESULTS_DIR = path.join(__dirname, "..", "tmp");

interface ReplayMetric {
  id: string;
  question: string;
  status: "ok" | "error" | "timeout";
  latencyMs: number;
  answer?: string;
  chartCount?: number;
  outcome?: string;
}

interface ReplaySummary {
  label: string;
  metrics: ReplayMetric[];
  okCount: number;
  errorCount: number;
  timeoutCount: number;
  totalLatencyMs: number;
}

async function loadSummary(label: string): Promise<ReplaySummary> {
  const p = path.join(RESULTS_DIR, `golden-replay-${label}.json`);
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as ReplaySummary;
  } catch (err) {
    console.error(`❌ could not read ${p}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/** Levenshtein-free quick approximation: normalized Jaccard over word sets. */
function answerOverlap(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const ws = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
  const sa = ws(a);
  const sb = ws(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let intersect = 0;
  for (const w of sa) if (sb.has(w)) intersect++;
  return intersect / new Set([...sa, ...sb]).size;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error("usage: llm-golden-diff <baseline-label> <candidate-label>");
    process.exit(2);
  }
  const baseline = await loadSummary(argv[0]);
  const candidate = await loadSummary(argv[1]);

  // Index for join.
  const cByid = new Map<string, ReplayMetric>();
  for (const m of candidate.metrics) cByid.set(m.id, m);

  console.log(
    `📊 ${argv[0]} vs ${argv[1]} — ${baseline.metrics.length} questions`
  );
  console.log("");
  console.log(
    `${"".padEnd(20)} ${"baseline".padStart(15)} ${"candidate".padStart(15)} ${"delta".padStart(15)}`
  );
  console.log("-".repeat(70));
  const fmt = (k: string, b: string | number, c: string | number, d: string | number) =>
    console.log(
      `${k.padEnd(20)} ${String(b).padStart(15)} ${String(c).padStart(15)} ${String(d).padStart(15)}`
    );
  fmt("ok turns", baseline.okCount, candidate.okCount, candidate.okCount - baseline.okCount);
  fmt(
    "error turns",
    baseline.errorCount,
    candidate.errorCount,
    candidate.errorCount - baseline.errorCount
  );
  fmt(
    "timeout turns",
    baseline.timeoutCount,
    candidate.timeoutCount,
    candidate.timeoutCount - baseline.timeoutCount
  );
  fmt(
    "total latency (s)",
    (baseline.totalLatencyMs / 1000).toFixed(1),
    (candidate.totalLatencyMs / 1000).toFixed(1),
    ((candidate.totalLatencyMs - baseline.totalLatencyMs) / 1000).toFixed(1)
  );

  console.log("");
  console.log("Per-question (changes only):");
  let changes = 0;
  for (const b of baseline.metrics) {
    const c = cByid.get(b.id);
    if (!c) continue;
    const overlap = answerOverlap(b.answer, c.answer);
    const statusChanged = b.status !== c.status;
    const chartsChanged = (b.chartCount ?? 0) !== (c.chartCount ?? 0);
    const lowOverlap = overlap < 0.5;
    if (!statusChanged && !chartsChanged && !lowOverlap) continue;
    changes++;
    const flags = [
      statusChanged ? `status:${b.status}→${c.status}` : "",
      chartsChanged ? `charts:${b.chartCount ?? 0}→${c.chartCount ?? 0}` : "",
      lowOverlap ? `overlap:${(overlap * 100).toFixed(0)}%` : "",
    ]
      .filter(Boolean)
      .join("  ");
    const dt = c.latencyMs - b.latencyMs;
    console.log(`- ${b.id}  Δlat=${dt > 0 ? "+" : ""}${dt}ms  ${flags}`);
    console.log(`  q: ${b.question.slice(0, 100)}`);
  }
  if (changes === 0) {
    console.log("(no significant changes)");
  }

  // Exit non-zero on regression: any new error/timeout in candidate.
  const newErrors =
    candidate.errorCount - baseline.errorCount + (candidate.timeoutCount - baseline.timeoutCount);
  if (newErrors > 0) {
    console.error(`\n❌ candidate has ${newErrors} more error/timeout(s) than baseline`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
