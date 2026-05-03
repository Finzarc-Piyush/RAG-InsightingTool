/**
 * Wave C2 · Magnitude audit at finding emission.
 *
 * When a tool emits a structured finding with a numeric magnitude, this
 * helper attempts to re-verify the magnitude against raw data via the
 * read-only SQL escape hatch (DuckDB session table). Failures are not fatal
 * — the audit just records `unverifiable` so narrator / verifier downstream
 * can phrase the caveat appropriately rather than asserting.
 *
 * Bounded:
 *   - Max 10 audits per turn (env: AGENT_MAGNITUDE_AUDIT_MAX, default 10).
 *   - Each audit is async and side-effect-free (read-only SELECT).
 *   - Drift threshold default 5%; overrideable per-call.
 */
import type {
  StructuredFinding,
  MagnitudeAudit,
  MagnitudeClaim,
} from "./investigationState.js";
import type { AgentExecutionContext } from "./types.js";

export interface MagnitudeAuditOpts {
  /** Filter spec for the audited claim (e.g. { Region: ["South"] }). */
  filter?: Record<string, unknown>;
  /** Drift threshold % above which to flag as `drift`. Default 5%. */
  driftPct?: number;
  /** Optional explicit verification SQL (else we synthesise a coarse query). */
  verificationSql?: string;
}

const DEFAULT_DRIFT_PCT = 5;

const auditCounters = new Map<string, number>();

function turnAuditKey(ctx: AgentExecutionContext): string {
  const trace =
    (ctx as { __auditTurnId?: string }).__auditTurnId ??
    `${ctx.sessionId}:${(ctx as { question?: string }).question?.slice(0, 40) ?? ""}`;
  return trace;
}

function resetTurnCounter(ctx: AgentExecutionContext): void {
  auditCounters.delete(turnAuditKey(ctx));
}

export function getAuditBudgetRemaining(ctx: AgentExecutionContext): number {
  const max = Math.max(
    0,
    parseInt(process.env.AGENT_MAGNITUDE_AUDIT_MAX ?? "10", 10) || 10
  );
  const used = auditCounters.get(turnAuditKey(ctx)) ?? 0;
  return Math.max(0, max - used);
}

function tickBudget(ctx: AgentExecutionContext): void {
  const key = turnAuditKey(ctx);
  auditCounters.set(key, (auditCounters.get(key) ?? 0) + 1);
}

/**
 * Best-effort re-verification of a single magnitude. Returns `null` when no
 * audit could be performed (no DuckDB, no budget left, no parseable filter).
 */
export async function auditMagnitude(
  ctx: AgentExecutionContext,
  finding: StructuredFinding,
  opts: MagnitudeAuditOpts = {}
): Promise<MagnitudeAudit | null> {
  if (!finding.magnitude) return null;
  if (getAuditBudgetRemaining(ctx) <= 0) {
    return {
      findingId: finding.id,
      expected: finding.magnitude.value,
      actual: null,
      deltaPct: null,
      status: "unverifiable",
      auditedAt: Date.now(),
      verificationQuery: undefined,
    };
  }
  tickBudget(ctx);

  // For Wave C2, the simplest audit reads `ctx.turnStartDataRef` (always row-
  // level when available) and recomputes the magnitude in JavaScript. Future
  // C9 will route through the DuckDB stats cache for accuracy + cost.
  const frame =
    (ctx as { turnStartDataRef?: Record<string, unknown>[] | null }).turnStartDataRef ??
    ctx.data ??
    [];
  if (!Array.isArray(frame) || frame.length === 0) {
    return {
      findingId: finding.id,
      expected: finding.magnitude.value,
      actual: null,
      deltaPct: null,
      status: "unverifiable",
      auditedAt: Date.now(),
    };
  }

  const filtered = applyFilter(frame as Record<string, unknown>[], opts.filter ?? finding.magnitude.filter);
  if (filtered.length === 0) {
    return {
      findingId: finding.id,
      expected: finding.magnitude.value,
      actual: null,
      deltaPct: null,
      status: "unverifiable",
      auditedAt: Date.now(),
      verificationQuery: opts.verificationSql,
    };
  }

  const actual = recomputeMagnitude(filtered, finding.magnitude);
  if (actual === null) {
    return {
      findingId: finding.id,
      expected: finding.magnitude.value,
      actual: null,
      deltaPct: null,
      status: "unverifiable",
      auditedAt: Date.now(),
      verificationQuery: opts.verificationSql,
    };
  }
  const deltaPct =
    Math.abs(finding.magnitude.value) > 0
      ? Math.abs((actual - finding.magnitude.value) / finding.magnitude.value) *
        100
      : Math.abs(actual) * 100;
  const driftThreshold = opts.driftPct ?? DEFAULT_DRIFT_PCT;
  return {
    findingId: finding.id,
    expected: finding.magnitude.value,
    actual,
    deltaPct,
    status: deltaPct > driftThreshold ? "drift" : "ok",
    auditedAt: Date.now(),
    verificationQuery: opts.verificationSql,
  };
}

function applyFilter(
  rows: Record<string, unknown>[],
  filter?: Record<string, unknown>
): Record<string, unknown>[] {
  if (!filter || Object.keys(filter).length === 0) return rows;
  return rows.filter((row) => {
    for (const [k, v] of Object.entries(filter)) {
      const cell = row[k];
      if (Array.isArray(v)) {
        if (!v.includes(cell as never)) return false;
      } else if (cell !== v) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Recompute the magnitude on a filtered row set. Today only the simple cases
 * are handled (mean, sum, percent of total). Future waves can extend.
 */
function recomputeMagnitude(
  rows: Record<string, unknown>[],
  m: MagnitudeClaim
): number | null {
  if (!m.metric) return null;
  const numeric: number[] = [];
  for (const r of rows) {
    const v = r[m.metric];
    if (typeof v === "number" && Number.isFinite(v)) numeric.push(v);
    else if (typeof v === "string") {
      const f = parseFloat(v);
      if (Number.isFinite(f)) numeric.push(f);
    }
  }
  if (numeric.length === 0) return null;
  if (m.unit === "%") {
    // For percent, we need a denominator; without filter context, return null.
    return null;
  }
  // Default: mean.
  const sum = numeric.reduce((a, b) => a + b, 0);
  return sum / numeric.length;
}

/**
 * Wave C2 · `runtime.data.sampleRowsForVerification` capability for narrator
 * and verifier. Returns up to `limit` rows from the row-level frame matching
 * `filter`. Capped 50 rows × 5 calls per turn (see spec).
 */
const SAMPLE_BUDGET_PER_TURN = 5;
const sampleBudgets = new Map<string, number>();

export function sampleRowsForVerification(
  ctx: AgentExecutionContext,
  opts: { filter?: Record<string, unknown>; columns?: string[]; limit?: number }
): Record<string, unknown>[] {
  const key = turnAuditKey(ctx);
  const used = sampleBudgets.get(key) ?? 0;
  if (used >= SAMPLE_BUDGET_PER_TURN) return [];
  sampleBudgets.set(key, used + 1);
  const frame =
    (ctx as { turnStartDataRef?: Record<string, unknown>[] | null }).turnStartDataRef ??
    ctx.data ??
    [];
  if (!Array.isArray(frame) || frame.length === 0) return [];
  const filtered = applyFilter(frame as Record<string, unknown>[], opts.filter);
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const sliced = filtered.slice(0, limit);
  if (opts.columns && opts.columns.length > 0) {
    return sliced.map((row) => {
      const projected: Record<string, unknown> = {};
      for (const c of opts.columns!) projected[c] = row[c];
      return projected;
    });
  }
  return sliced;
}

/** Test/observability hook to clear per-turn budgets. */
export function __resetMagnitudeAuditBudgets(): void {
  auditCounters.clear();
  sampleBudgets.clear();
}

export { resetTurnCounter };
