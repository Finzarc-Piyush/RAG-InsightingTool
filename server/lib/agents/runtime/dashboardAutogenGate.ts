/**
 * ============================================================================
 * dashboardAutogenGate.ts — should we auto-build (and save) a dashboard?
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Pure-logic gating for "dashboard autogeneration" (the engine building a
 *   dashboard on its own). It checks the master feature flag, a percentage-based
 *   rollout (only some users enrolled), and whether the turn actually has charts
 *   to put on a dashboard. It also turns a DashboardIntent into build/persist
 *   decisions (build the spec? save it, or just offer a button?).
 *
 * WHY IT MATTERS
 *   It lives apart from buildDashboard.ts so this decision logic can be unit
 *   tested without dragging in the agent runtime + openai module (which
 *   initializes credentials on load). The rollout is deterministic per user
 *   (same user → same bucket) so behavior is stable across their sessions.
 *
 * KEY PIECES
 *   - isDashboardAutogenEnabled() / dashboardAutogenRolloutPct() — read flags.
 *   - isUserEnrolledInDashboardAutogenRollout(userKey) — hash userKey into a
 *     0–99 bucket and compare to the rollout percent.
 *   - shouldBuildDashboard(args) — legacy explicit-ask gate.
 *   - dashboardBuildDecision(args) — intent-aware { build, persist } decision.
 *
 * HOW IT CONNECTS
 *   Consumes DashboardIntent from dashboardIntent.ts and AnalysisBrief/ChartSpec
 *   from shared/schema.ts. Called inside the agent loop before buildDashboard.
 *
 * Flags:
 *   DASHBOARD_AUTOGEN_ENABLED           feature gate (master)
 *   DASHBOARD_AUTOGEN_ROLLOUT_PCT       per-user enrollment percent (0–100, default 100)
 *   OPENAI_MODEL_FOR_BUILD_DASHBOARD    model routing override for this role
 */

import type { AnalysisBrief, ChartSpec } from "../../../shared/schema.js";
import type { DashboardIntent } from "./dashboardIntent.js";
import { isFlagOn } from "../../featureFlags.js";

export function isDashboardAutogenEnabled(): boolean {
  return isFlagOn("DASHBOARD_AUTOGEN_ENABLED");
}

/**
 * Deterministic per-user rollout percentage. 0–100; defaults to 100
 * (full rollout) when unset. Out-of-range values clamp.
 */
export function dashboardAutogenRolloutPct(): number {
  const raw = process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT;
  if (!raw) return 100;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, n));
}

/** FNV-1a 32-bit → bucket in [0, buckets). Same hash recipe as the model-rollout ramp. */
function hashToBucket(seed: string, buckets = 100): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % buckets;
}

/**
 * Decide whether `userKey` falls inside the current rollout. Stable across
 * sessions for the same user. When `userKey` is absent, falls back to a
 * timestamp-based seed so anonymous turns aren't pinned to one bucket.
 */
export function isUserEnrolledInDashboardAutogenRollout(
  userKey: string | undefined
): boolean {
  const pct = dashboardAutogenRolloutPct();
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  const seed = (userKey ?? String(Date.now())).toLowerCase();
  return hashToBucket(seed, 100) < pct;
}

export function shouldBuildDashboard(args: {
  brief?: AnalysisBrief;
  charts: ChartSpec[];
  /** Used by the rollout ramp; pass `ctx.username` from the agent loop. */
  userKey?: string;
}): boolean {
  if (!isDashboardAutogenEnabled()) return false;
  if (!args.brief?.requestsDashboard) return false;
  if (!Array.isArray(args.charts) || args.charts.length === 0) return false;
  if (!isUserEnrolledInDashboardAutogenRollout(args.userKey)) return false;
  return true;
}

/**
 * Intent-aware decision: whether to BUILD a dashboard spec for this turn, and
 * whether to PERSIST it (auto_create) vs surface it as a clickable offer
 * ("Build Dashboard" button on the client).
 *
 * `build=true, persist=true`  → explicit ask path (existing behavior)
 * `build=true, persist=false` → multi-chart offer path (new)
 * `build=false`               → no spec emitted
 */
export function dashboardBuildDecision(args: {
  intent: DashboardIntent;
  charts: ChartSpec[];
  /** Used by the rollout ramp; pass `ctx.username` from the agent loop. */
  userKey?: string;
}): { build: boolean; persist: boolean } {
  if (!isDashboardAutogenEnabled()) return { build: false, persist: false };
  if (args.intent === "none") return { build: false, persist: false };
  if (!Array.isArray(args.charts) || args.charts.length === 0)
    return { build: false, persist: false };
  if (!isUserEnrolledInDashboardAutogenRollout(args.userKey))
    return { build: false, persist: false };
  return { build: true, persist: args.intent === "auto_create" };
}
