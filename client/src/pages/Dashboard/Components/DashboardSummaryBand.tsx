import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Compass,
  HelpCircle,
  ListChecks,
  Sparkles,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Eyebrow, Heading } from "@/components/ui/typography";
import { MagnitudesRow } from "@/pages/Home/Components/MagnitudesRow";
import type { AttentionAreaSpec, DashboardAnswerEnvelope } from "@/shared/schema";
import { selectSummaryBandData, selectAttentionAreas } from "../lib/summaryBandData";

/**
 * Wave ES1 · the Executive-Summary band — the dashboard's self-explanatory
 * first view.
 *
 * The decision-grade `answerEnvelope` already rides on the dashboard but was
 * only reachable through a right-side drawer (DR2), so the first paint was a
 * minimal wall of text + markdown KPI bullets. This band surfaces the headline
 * takeaway (TL;DR), the key numbers as gold KPI cards (reusing `MagnitudesRow`,
 * the signature gold surface), and the top findings as compact callouts — then
 * links to the full drawer for the deep detail (methodology, caveats,
 * recommendations, investigation).
 *
 * Kept COMPACT and COLLAPSIBLE (default open, persisted per dashboard) so the
 * charts still lead the page — the balance DR2 was reaching for, but visual
 * instead of hidden. Rendered only on the first (Executive Summary) sheet.
 */

const STORAGE_PREFIX = "dashboard-summary-band-open:";

/** IUX3 · horizon chip labels — mirrors the drawer's RecommendationsByHorizon. */
const HORIZON_LABEL: Record<"now" | "this_quarter" | "strategic", string> = {
  now: "Now",
  this_quarter: "This quarter",
  strategic: "Strategic",
};

// W-DX1 · the hedged causal lane on the dashboard band. Same labels + standing
// disclaimer as the chat AnswerCard so a CXO reads "why" identically everywhere.
const DRIVER_BASIS_LABEL: Record<"data" | "domain" | "general", string> = {
  data: "from the data",
  domain: "industry knowledge",
  general: "general knowledge",
};
const LIKELY_DRIVERS_DISCLAIMER =
  "Plausible explanations — hypotheses, not measured in this data unless marked “from the data”.";

function readOpen(dashboardId: string): boolean {
  if (typeof sessionStorage === "undefined") return true;
  try {
    return sessionStorage.getItem(`${STORAGE_PREFIX}${dashboardId}`) !== "0";
  } catch {
    return true;
  }
}

function writeOpen(dashboardId: string, open: boolean): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}${dashboardId}`, open ? "1" : "0");
  } catch {
    /* quota / private mode — ignore */
  }
}

export interface DashboardSummaryBandProps {
  dashboardId: string;
  envelope?: DashboardAnswerEnvelope;
  /** MW4 · below-org-average units to surface as an "Attention areas" callout
   *  (management-by-exception). Sourced from the DashboardSpec, not the envelope. */
  attentionAreas?: AttentionAreaSpec[];
  /** MW4/MW6 · click a problem area to filter/drill into it. */
  onAttentionAreaClick?: (area: AttentionAreaSpec) => void;
  /** Opens the full analysis-summary drawer for the deep detail. */
  onOpenSummary?: () => void;
}

export function DashboardSummaryBand({
  dashboardId,
  envelope,
  attentionAreas,
  onAttentionAreaClick,
  onOpenSummary,
}: DashboardSummaryBandProps) {
  const [open, setOpen] = useState<boolean>(() => readOpen(dashboardId));
  useEffect(() => setOpen(readOpen(dashboardId)), [dashboardId]);
  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      writeOpen(dashboardId, next);
      return next;
    });
  }, [dashboardId]);

  const { tldr, magnitudes, findings, implications, likelyDrivers, priorityActions } =
    selectSummaryBandData(envelope);
  const attention = selectAttentionAreas(attentionAreas);
  if (
    !tldr &&
    magnitudes.length === 0 &&
    findings.length === 0 &&
    attention.length === 0 &&
    implications.length === 0 &&
    likelyDrivers.length === 0 &&
    priorityActions.length === 0
  )
    return null;

  return (
    <Card className="mb-4 overflow-hidden border-border/60">
      <div className="flex items-center justify-between gap-3 px-4 pt-3.5 lg:px-5">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={`dashboard-summary-band-${dashboardId}`}
          className="group flex items-center gap-2 rounded-brand-sm text-left transition-colors hover:opacity-90"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          )}
          <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
          <Eyebrow>Executive summary</Eyebrow>
          {!open && tldr ? (
            <span className="ml-1 truncate text-sm text-muted-foreground max-w-[40vw]">
              {tldr}
            </span>
          ) : null}
        </button>
        {onOpenSummary ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSummary}
            className="h-7 flex-shrink-0 px-2 text-xs text-primary hover:text-primary"
          >
            Full summary
            <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {open ? (
        <div
          id={`dashboard-summary-band-${dashboardId}`}
          className="px-4 pb-4 lg:px-5"
        >
          {tldr ? (
            <Heading size="md" as="p" className="mt-2 max-w-4xl text-foreground/90">
              {tldr}
            </Heading>
          ) : null}

          <MagnitudesRow items={magnitudes} label="Key numbers" />

          {attention.length > 0 ? (
            <div className="mt-4">
              <Eyebrow className="mb-2 block">Attention areas</Eyebrow>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {attention.map((a, i) => {
                  const isRed = a.status === "red";
                  const tone = isRed
                    ? "border-destructive/40 bg-destructive/5"
                    : "border-amber-500/40 bg-amber-500/5";
                  const dot = isRed ? "bg-destructive" : "bg-amber-500";
                  const clickable = Boolean(onAttentionAreaClick && attentionAreas?.[i]);
                  return (
                    <button
                      key={`attn-${i}`}
                      type="button"
                      disabled={!clickable}
                      onClick={
                        clickable ? () => onAttentionAreaClick!(attentionAreas![i]) : undefined
                      }
                      className={`flex w-full items-start gap-2 rounded-brand-sm border ${tone} px-3 py-2 text-left shadow-elev-1 ${
                        clickable ? "cursor-pointer hover:opacity-90" : "cursor-default"
                      }`}
                      title={clickable ? `Filter to ${a.unit}` : undefined}
                    >
                      <span
                        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${dot}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium leading-snug text-foreground">
                          {a.unit}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {a.metric}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                        {a.deltaLabel}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {findings.length > 0 ? (
            <div className="mt-4">
              <Eyebrow className="mb-2 block">Key findings</Eyebrow>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {findings.map((f, i) => (
                  <div
                    key={`band-finding-${i}`}
                    className="rounded-brand-sm border border-border bg-card px-3 py-2 shadow-elev-1"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium leading-snug text-foreground">
                        {f.headline}
                      </span>
                      {f.magnitude ? (
                        <span className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary tabular-nums">
                          {f.magnitude}
                        </span>
                      ) : null}
                    </div>
                    {f.evidence ? (
                      <p className="mt-1 text-xs leading-snug text-muted-foreground">
                        {f.evidence}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {likelyDrivers.length > 0 ? (
            <div className="mt-4">
              <Eyebrow className="mb-1 flex items-center gap-1.5">
                <HelpCircle className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                Why it might be happening
              </Eyebrow>
              <p className="mb-2 text-[11px] italic leading-[15px] text-muted-foreground">
                {LIKELY_DRIVERS_DISCLAIMER}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {likelyDrivers.map((d, i) => (
                  <div
                    key={`band-driver-${i}`}
                    className="rounded-brand-sm border border-dashed border-border bg-muted/20 px-3 py-2"
                  >
                    <div className="text-sm leading-snug text-foreground">
                      {d.explanation}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {DRIVER_BASIS_LABEL[d.basis] ?? d.basis}
                      </span>
                      {d.testable ? (
                        <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                          testable here
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {implications.length > 0 ? (
            <div className="mt-4">
              <Eyebrow className="mb-2 flex items-center gap-1.5">
                <Compass className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                Why it matters
              </Eyebrow>
              <div className="grid gap-2 sm:grid-cols-2">
                {implications.map((imp, i) => (
                  <div
                    key={`band-impl-${i}`}
                    className="rounded-brand-sm border border-border bg-muted/20 px-3 py-2 shadow-elev-1"
                  >
                    <div className="text-sm font-medium leading-snug text-foreground">
                      {imp.statement}
                    </div>
                    <div className="mt-1 text-xs leading-snug text-muted-foreground">
                      <span className="font-medium text-foreground">So what:</span>{" "}
                      {imp.soWhat}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {priorityActions.length > 0 ? (
            <div className="mt-4">
              <Eyebrow className="mb-2 flex items-center gap-1.5">
                <ListChecks className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                Priority actions
              </Eyebrow>
              <div className="space-y-2">
                {priorityActions.map((a, i) => (
                  <div
                    key={`band-action-${i}`}
                    className="flex items-start gap-2 rounded-brand-sm border border-primary/30 bg-primary/5 px-3 py-2 shadow-elev-1"
                  >
                    <ArrowRight
                      className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium leading-snug text-foreground">
                          {a.action}
                        </span>
                        {a.horizon ? (
                          <span className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                            {HORIZON_LABEL[a.horizon]}
                          </span>
                        ) : null}
                      </div>
                      {a.expectedImpact ? (
                        <div className="mt-1 text-xs leading-snug text-muted-foreground">
                          <span className="font-medium text-foreground">
                            Expected impact:
                          </span>{" "}
                          {a.expectedImpact}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
