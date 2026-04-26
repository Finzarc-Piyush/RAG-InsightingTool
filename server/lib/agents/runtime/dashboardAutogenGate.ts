/**
 * Pure-logic gating for dashboard autogeneration. Lives separately from
 * `buildDashboard.ts` so the gate can be unit-tested without pulling in the
 * agent runtime + openai module IIFE.
 *
 * Flags:
 *   DASHBOARD_AUTOGEN_ENABLED           feature gate (master)
 *   DASHBOARD_AUTOGEN_ROLLOUT_PCT       per-user enrollment percent (0–100, default 100)
 *   OPENAI_MODEL_FOR_BUILD_DASHBOARD    routing override on top of W3.x
 */

import type { AnalysisBrief, ChartSpec } from "../../../shared/schema.js";

export function isDashboardAutogenEnabled(): boolean {
  return process.env.DASHBOARD_AUTOGEN_ENABLED === "true";
}

/**
 * W7.6 · Deterministic per-user rollout percentage. 0–100; defaults to 100
 * (full rollout) when unset. Out-of-range values clamp.
 */
export function dashboardAutogenRolloutPct(): number {
  const raw = process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT;
  if (!raw) return 100;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, n));
}

/** FNV-1a 32-bit → bucket in [0, buckets). Same hash recipe as W3.10's MINI ramp. */
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
  /** Used by the W7.6 ramp; pass `ctx.username` from the agent loop. */
  userKey?: string;
}): boolean {
  if (!isDashboardAutogenEnabled()) return false;
  if (!args.brief?.requestsDashboard) return false;
  if (!Array.isArray(args.charts) || args.charts.length === 0) return false;
  if (!isUserEnrolledInDashboardAutogenRollout(args.userKey)) return false;
  return true;
}
