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
}

export interface SummaryBandData {
  tldr: string | null;
  magnitudes: MagnitudeItem[];
  findings: SummaryBandFinding[];
}

const DEFAULT_MAX_FINDINGS = 3;
const MAX_MAGNITUDES = 6;

function hasText(s: string | undefined | null): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

/** True when the envelope has anything worth surfacing in the band. */
export function hasSummaryBandContent(envelope?: DashboardAnswerEnvelope): boolean {
  if (!envelope) return false;
  return (
    hasText(envelope.tldr) ||
    (envelope.magnitudes?.length ?? 0) > 0 ||
    (envelope.findings?.length ?? 0) > 0
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
      ...(m.confidence ? { confidence: m.confidence } : {}),
    }));

  const findings: SummaryBandFinding[] = (envelope?.findings ?? [])
    .filter((f) => hasText(f?.headline))
    .slice(0, Math.max(0, maxFindings))
    .map((f) => ({
      headline: f.headline,
      ...(hasText(f.magnitude) ? { magnitude: f.magnitude } : {}),
    }));

  return { tldr, magnitudes, findings };
}
