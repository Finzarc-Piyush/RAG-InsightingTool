/**
 * Wave CS2 · Pure builders for the on-demand orient pack.
 *
 * Cold-start initiative Piece 2. These functions turn already-gathered facts
 * (live git state, invariant results, doc sizes, lesson titles) into the
 * compact markdown a fresh session reads at warmup. They do NO IO — the
 * generator (generate-bootstrap.ts) gathers the inputs and calls these, so the
 * formatting is unit-testable without a repo. The pack is printed on demand and
 * never committed: there is no snapshot to drift (the fix for STATE.md going
 * 62 commits stale was to stop storing volatile state at all).
 */

export interface RecentCommit {
  hash: string;
  subject: string;
}

export interface GitState {
  branch: string;
  headShort: string;
  headSubject: string;
  dirtyCount: number;
  /** Commits on HEAD not yet in origin/main; null when unknown (shallow clone). */
  commitsSinceMain: number | null;
  /** Relative date of HEAD, e.g. "2 days ago". */
  newestDateRel: string;
}

export interface DocEntry {
  path: string;
  /** ~tokens (bytes / 4). */
  tokens: number;
  /** ISO date (yyyy-mm-dd) the doc was last committed. */
  lastTouched: string;
}

export interface LessonHead {
  id: string;
  title: string;
}

export interface InvariantSummary {
  passed: number;
  total: number;
  /** "I4: detail" strings for any failing checks. */
  failures: string[];
}

export interface BootstrapInput {
  git: GitState;
  recentCommits: RecentCommit[];
  churnedFiles: string[];
  planTitle: string | null;
  streams: string | null;
  invariants: InvariantSummary;
  docs: DocEntry[];
  lessons: LessonHead[];
  /** Footer note (timestamp/command) — passed in to keep builders pure. */
  generatedNote: string;
}

/** Docs at or above this token estimate are flagged LARGE (blows a /load budget). */
export const LARGE_TOKENS = 8000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function fmtTokens(t: number): string {
  return t >= 1000 ? `${Math.round(t / 1000)}K` : `${t}`;
}

export function buildHeader(git: GitState): string {
  const dirty = git.dirtyCount === 0 ? "clean" : `${git.dirtyCount} file(s) uncommitted`;
  const ahead =
    git.commitsSinceMain == null
      ? ""
      : ` · ${git.commitsSinceMain} commit(s) ahead of origin/main`;
  return [
    `# Orient — live project state (generated fresh, cannot be stale)`,
    ``,
    `**Branch** \`${git.branch}\` @ \`${git.headShort}\` — ${git.headSubject}`,
    `**Tree** ${dirty}${ahead} · last commit ${git.newestDateRel}`,
  ].join("\n");
}

export function buildInvariantLine(inv: InvariantSummary): string {
  if (inv.failures.length === 0) {
    return `**Invariants** ✓ ${inv.passed}/${inv.total} kernels hold — firewall green, docs trustworthy.`;
  }
  return [
    `**Invariants** ✗ ${inv.passed}/${inv.total} — FIREWALL FAILING; CLAUDE.md may mislead you. Fix before trusting docs:`,
    ...inv.failures.map((f) => `  - ${f}`),
  ].join("\n");
}

/** Coarse active-area guess from recently churned file paths. */
export function inferSubsystem(files: string[]): string | null {
  const counts = new Map<string, number>();
  const bump = (a: string) => counts.set(a, (counts.get(a) ?? 0) + 1);
  for (const f of files) {
    if (f.includes("lib/agents")) bump("agent-runtime");
    else if (/charts?|Chart/.test(f)) bump("charting");
    else if (f.includes("dataOps") || f.startsWith("python-service/")) bump("data-ops/mmm");
    else if (f.startsWith("client/")) bump("client");
    else if (f.startsWith("docs/")) bump("docs");
    else if (f.startsWith("server/")) bump("server");
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [a, n] of counts) {
    if (n > bestN) {
      best = a;
      bestN = n;
    }
  }
  return best;
}

export function buildChurn(commits: RecentCommit[], churnedFiles: string[]): string {
  const subsystem = inferSubsystem(churnedFiles);
  const head = subsystem ? `## Recent activity (active area: ${subsystem})` : `## Recent activity`;
  const rows = commits.slice(0, 10).map((c) => `- \`${c.hash}\` ${c.subject}`);
  return [head, ...rows].join("\n");
}

export function buildWip(planTitle: string | null, streams: string | null): string {
  const lines = [`## WIP`, `- Active plan: ${planTitle ?? "none"}`];
  if (streams && streams.trim()) lines.push(streams.trim());
  return lines.join("\n");
}

export function buildRouting(docs: DocEntry[]): string {
  const rows = docs.map((d) => {
    const flag = d.tokens >= LARGE_TOKENS ? " **LARGE**" : "";
    return `- ${d.path} — ~${fmtTokens(d.tokens)} tok · touched ${d.lastTouched}${flag}`;
  });
  return [`## Docs (size + freshness — open or /load only what the task needs)`, ...rows].join("\n");
}

export function buildLessons(lessons: LessonHead[]): string {
  const recent = lessons.slice(-8);
  return [
    `## Recent lessons (titles only — open docs/lessons.md for the rule)`,
    ...recent.map((l) => `- ${l.id} — ${l.title}`),
  ].join("\n");
}

export function assembleBootstrap(input: BootstrapInput): string {
  return [
    buildHeader(input.git),
    buildInvariantLine(input.invariants),
    "",
    buildChurn(input.recentCommits, input.churnedFiles),
    "",
    buildWip(input.planTitle, input.streams),
    "",
    buildRouting(input.docs),
    "",
    buildLessons(input.lessons),
    "",
    `_${input.generatedNote}_`,
  ].join("\n");
}
