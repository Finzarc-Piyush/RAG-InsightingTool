/**
 * Wave ES1 · pure data selector for the dashboard's Executive-Summary band.
 *
 * The dashboard already persists a decision-grade `answerEnvelope` (TL;DR,
 * magnitudes, findings, …) but the first view only ever showed it as a markdown
 * "Headline numbers" tile + a hidden drawer. This selector extracts the few
 * fields the always-visible summary band renders — keeping the band compact
 * (so charts still lead the page, per the DR2 lesson) while making the first
 * view self-explanatory. Pure — the testable seam; the band JSX is thin.
 */
import type { AttentionAreaSpec, DashboardAnswerEnvelope } from "@/shared/schema";
import type { MagnitudeItem } from "@/pages/Home/Components/MagnitudesRow";

export interface AttentionAreaDisplay {
  /** The under-performing unit, e.g. "Bihar West". */
  unit: string;
  /** The breakdown dimension, e.g. "ASM". */
  dimension: string;
  /** Metric label (chart title), e.g. "PJP Adherence rate by ASM". */
  metric: string;
  /** e.g. "32% below avg" — the manager's at-a-glance gap. */
  deltaLabel: string;
  status: "red" | "amber";
}

/**
 * MW4 · format the dashboard's deterministic attention areas (below-org-average
 * units) into compact display rows for the "Attention areas" callout. Pure.
 */
export function selectAttentionAreas(
  areas: readonly AttentionAreaSpec[] | undefined,
): AttentionAreaDisplay[] {
  return (areas ?? [])
    .filter((a) => a && typeof a.unit === "string" && a.unit.trim().length > 0)
    .map((a) => ({
      unit: a.unit,
      dimension: a.dimension,
      metric: a.metric,
      deltaLabel: `${Math.abs(Math.round(a.variancePct))}% below avg`,
      status: a.status,
    }));
}

export interface SummaryBandFinding {
  headline: string;
  magnitude?: string;
  /** IUX3 · short "what we saw" snippet so a finding reads as evidence, not a
   *  bare assertion. Truncated for the compact band; full text lives in the drawer. */
  evidence?: string;
}

/** IUX3 · the "why it matters" link — the business consequence of the findings. */
export interface SummaryBandImplication {
  statement: string;
  soWhat: string;
}

/** IUX3 · the "what to do" link — a grounded recommendation, surfaced on the band. */
export interface SummaryBandAction {
  action: string;
  expectedImpact?: string;
  horizon?: "now" | "this_quarter" | "strategic";
}

/** W-DX1 · a hedged "why this might be happening" explanation, sourced ONLY from
 *  the persisted, verifier-passed envelope (the band never re-generates one). */
export interface SummaryBandDriver {
  explanation: string;
  basis: "data" | "domain" | "general";
  testable?: boolean;
}

export interface SummaryBandData {
  tldr: string | null;
  magnitudes: MagnitudeItem[];
  findings: SummaryBandFinding[];
  /** IUX3 · top "so what" implications — the decision chain's middle link. */
  implications: SummaryBandImplication[];
  /** W-DX1 · top hedged "why this might be happening" drivers. */
  likelyDrivers: SummaryBandDriver[];
  /** IUX3 · top priority actions (recommendations), most-urgent horizon first. */
  priorityActions: SummaryBandAction[];
}

const DEFAULT_MAX_FINDINGS = 3;
const MAX_MAGNITUDES = 6;
const MAX_IMPLICATIONS = 2;
const MAX_DRIVERS = 2;
const MAX_PRIORITY_ACTIONS = 2;
const EVIDENCE_SNIPPET_MAX = 160;

/** Order recommendations so the most actionable horizon leads on the band. */
const HORIZON_RANK: Record<string, number> = {
  now: 0,
  this_quarter: 1,
  strategic: 2,
};

function hasText(s: string | undefined | null): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

/** Collapse whitespace and truncate to a compact, manager-readable snippet. */
function snippet(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** True when the envelope has anything worth surfacing in the band. */
export function hasSummaryBandContent(envelope?: DashboardAnswerEnvelope): boolean {
  if (!envelope) return false;
  return (
    hasText(envelope.tldr) ||
    (envelope.magnitudes?.length ?? 0) > 0 ||
    (envelope.findings?.length ?? 0) > 0 ||
    (envelope.implications?.length ?? 0) > 0 ||
    (envelope.likelyDrivers?.length ?? 0) > 0 ||
    (envelope.recommendations?.length ?? 0) > 0
  );
}

export function selectSummaryBandData(
  envelope?: DashboardAnswerEnvelope,
  maxFindings: number = DEFAULT_MAX_FINDINGS,
): SummaryBandData {
  const tldr = hasText(envelope?.tldr) ? (envelope!.tldr as string).trim() : null;

  const magnitudes: MagnitudeItem[] = (envelope?.magnitudes ?? [])
    .filter((m) => hasText(m?.label) && hasText(m?.value))
    .slice(0, MAX_MAGNITUDES)
    .map((m) => ({
      label: m.label,
      value: m.value,
      // W-SBCOLOR · carry the user-chosen colour through to the card; fall back
      // to the legacy confidence chip only for un-toned (legacy) magnitudes.
      ...(m.tone ? { tone: m.tone } : m.confidence ? { confidence: m.confidence } : {}),
    }));

  const findings: SummaryBandFinding[] = (envelope?.findings ?? [])
    .filter((f) => hasText(f?.headline))
    .slice(0, Math.max(0, maxFindings))
    .map((f) => ({
      headline: f.headline,
      ...(hasText(f.magnitude) ? { magnitude: f.magnitude } : {}),
      ...(hasText(f.evidence) ? { evidence: snippet(f.evidence, EVIDENCE_SNIPPET_MAX) } : {}),
    }));

  const implications: SummaryBandImplication[] = (envelope?.implications ?? [])
    .filter((i) => hasText(i?.statement) && hasText(i?.soWhat))
    .slice(0, MAX_IMPLICATIONS)
    .map((i) => ({ statement: i.statement.trim(), soWhat: i.soWhat.trim() }));

  // W-DX1 · lift the hedged causal lane straight from the persisted, verified
  // envelope (no re-generation on the dashboard → no unverified hallucination
  // channel). Basis/testable are preserved so the band can chip them.
  const likelyDrivers: SummaryBandDriver[] = (envelope?.likelyDrivers ?? [])
    .filter((d) => hasText(d?.explanation))
    .slice(0, MAX_DRIVERS)
    .map((d) => ({
      explanation: snippet(d.explanation, EVIDENCE_SNIPPET_MAX),
      basis: d.basis,
      ...(d.testable ? { testable: true } : {}),
    }));

  const priorityActions: SummaryBandAction[] = (envelope?.recommendations ?? [])
    .filter((r) => hasText(r?.action))
    .map((r, idx) => ({ r, idx }))
    // Stable sort: most-actionable horizon first, original order within a horizon.
    .sort(
      (a, b) =>
        (HORIZON_RANK[a.r.horizon ?? "now"] ?? 0) -
          (HORIZON_RANK[b.r.horizon ?? "now"] ?? 0) || a.idx - b.idx,
    )
    .slice(0, MAX_PRIORITY_ACTIONS)
    .map(({ r }) => ({
      action: r.action.trim(),
      ...(hasText(r.expectedImpact) ? { expectedImpact: r.expectedImpact!.trim() } : {}),
      ...(r.horizon ? { horizon: r.horizon } : {}),
    }));

  return { tldr, magnitudes, findings, implications, likelyDrivers, priorityActions };
}
