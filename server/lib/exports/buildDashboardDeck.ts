/**
 * W-EXP-7 · Top-level orchestrator: Dashboard → SlideDeckPlan → renderer.
 *
 * One function the controllers call:
 *   - buildDashboardDeckPptx(dashboard) → Buffer
 *   - buildDashboardDeckPdf(dashboard)  → Buffer  (lands in W-EXP-9/11)
 *
 * Pipeline:
 *   1. runDeckPlanner — Claude Opus 4.7, structured output, schema-validated
 *   2. autoRepairDeckPlan — deterministically fix the MECHANICAL rules
 *      (slide ordering + short speaker notes) with no LLM call
 *   3. verifyDeckPlan — deterministic gate, now ADVISORY: it DRIVES at most
 *      one repair round (for the genuinely-LLM rules — action-title wording,
 *      overloaded bullets) but can NEVER collapse a renderable multi-slide
 *      deck. If issues remain after repair we ship the best plan anyway
 *      (`buildDeck.shippedWithResidualIssues`) rather than the stub.
 *   4. Render via the requested format's renderer.
 *
 * `buildAndVerifyDeckPlan` returns null (→ caller renders the RICH fallback)
 * ONLY when the planner produced no schema-valid plan at all, or the plan was
 * too thin to be useful (< 3 slides). The verifier never forces a null.
 *
 * The fallback (`buildFallbackDeckPlan`) is itself a real deck — TitleSlide +
 * optional ExecSummary/KpiRow + one ChartWithInsight per chart + optional
 * Recommendations/Methodology — so even a total planner failure ships rendered
 * charts, not a 3-slide inventory stub. The agent log captures the reason so
 * ops can see why a particular dashboard took the fallback path.
 */
import { agentLog } from "../agents/runtime/agentLogger.js";
import {
  runDeckPlanner,
  chartIdFor,
  type DeckPlannerInputs,
  type DeckPlannerOptions,
} from "../agents/runtime/deckPlanner.js";
import { verifyDeckPlan, autoRepairDeckPlan } from "../agents/runtime/deckPlanVerifier.js";
import {
  LAYOUT_KIND,
  slideDeckPlanSchema,
  type SlideDeckPlan,
  type SlideSpec,
} from "../../shared/exportSchema.js";
import type {
  ChartSpec,
  Dashboard,
  DashboardAnswerEnvelope,
  DashboardSheet,
} from "../../shared/schema.js";
import { renderDeckPlanToPptxBuffer } from "./pptx/render.js";
import { renderDeckPlanToPdfBuffer } from "./pdf/render.js";
import { errorMessage } from "../../utils/errorMessage.js";
import { splitChartInsightLanes } from "../../shared/chartInsightLanes.js";

export interface BuildDeckOptions extends DeckPlannerOptions {
  /** ISO date (yyyy-mm-dd) — defaults to today. */
  generatedAt?: string;
  /** Confidentiality classification. Default "Internal". */
  confidentiality?: string;
  /** Author / "prepared for" line on the cover. Default omitted. */
  preparedFor?: string;
}

/**
 * Plan + verify + repair-once. Returns the validated plan, or null when the
 * pipeline can't produce one (caller renders a deterministic fallback).
 *
 * Wave B6 · Resolves the owning session's ambient context (permanent
 * notes, dimension hierarchies, wide-format shape, domain context) and
 * passes them as planner inputs. The dashboard may have been created on
 * a prior turn, so the user's notes / declared hierarchies may have
 * changed since — these reflect the CURRENT session state. Falls back
 * silently to "no extra context" when the session isn't reachable
 * (e.g. test calls that don't have Cosmos configured) — the deck
 * planner still works on dashboard contents alone.
 */
export async function buildAndVerifyDeckPlan(
  dashboard: Dashboard,
  opts: BuildDeckOptions = {}
): Promise<SlideDeckPlan | null> {
  const inputs: DeckPlannerInputs = {
    dashboard,
    generatedAt: opts.generatedAt,
    confidentiality: opts.confidentiality,
  };

  // Wave B6 · Best-effort lookup of session-level ambient context. The
  // dashboard's `sessionId` (DPF / DPF6 field) ties it to the session
  // that created it. We DON'T fail if any of these lookups error —
  // export must always work even on dashboards from sessions that have
  // been archived / had their context stripped.
  if (dashboard.sessionId) {
    try {
      const { getChatBySessionIdEfficient } = await import(
        "../../models/chat.model.js"
      );
      const chat = await getChatBySessionIdEfficient(dashboard.sessionId);
      if (chat) {
        if (chat.permanentContext?.trim()) {
          inputs.permanentContext = chat.permanentContext;
        }
        const hierarchies =
          chat.sessionAnalysisContext?.dataset?.dimensionHierarchies;
        if (hierarchies?.length) {
          inputs.dimensionHierarchies = hierarchies;
        }
        const wft = chat.dataSummary?.wideFormatTransform;
        if (wft?.detected) {
          inputs.wideFormatShape = {
            detected: wft.detected,
            shape: wft.shape,
            periodColumn: wft.periodColumn,
            periodIsoColumn: wft.periodIsoColumn,
            valueColumn: wft.valueColumn,
            metricColumn: wft.metricColumn,
            meltedColumns: wft.meltedColumns,
          };
        }
      }
    } catch (err) {
      const msg = errorMessage(err);
      agentLog("buildDeck.sessionContextLookupFailed", {
        turnId: opts.turnId,
        sessionId: dashboard.sessionId,
        error: msg.slice(0, 200),
      });
    }
  }
  try {
    const { loadEnabledDomainContext } = await import(
      "../domainContext/loadEnabledDomainContext.js"
    );
    const dc = await loadEnabledDomainContext();
    if (dc.text) inputs.domainContext = dc.text;
  } catch (err) {
    const msg = errorMessage(err);
    agentLog("buildDeck.domainContextLoadFailed", {
      turnId: opts.turnId,
      error: msg.slice(0, 200),
    });
  }

  // Initial planner call. A null here is the ONLY way the whole function
  // returns null — it means the planner produced NO schema-valid plan, so the
  // caller renders the rich deterministic fallback. Once we hold a schema-valid
  // plan, the verifier is advisory and can never force a null.
  const plan0 = await runDeckPlanner(inputs, opts);
  if (!plan0) {
    agentLog("buildDeck.plannerNull", { turnId: opts.turnId });
    return null;
  }

  // Deterministically fix the mechanical rules (ordering + short notes) BEFORE
  // spending an LLM repair — most decks pass after this with no second call.
  const auto0 = autoRepairDeckPlan(plan0);
  if (auto0.slides.length < 3) {
    // An anaemic 2-slide plan (e.g. Title + Methodology) isn't what the user
    // wants — route to the richer fallback instead of shipping it.
    agentLog("buildDeck.planTooThin", {
      turnId: opts.turnId,
      slideCount: auto0.slides.length,
    });
    return null;
  }

  const verdict = verifyDeckPlan(auto0);
  if (verdict.ok) {
    agentLog("buildDeck.planReady", {
      turnId: opts.turnId,
      slideCount: auto0.slides.length,
    });
    return auto0;
  }

  // Residual issues are the genuinely-LLM rules (action-title wording,
  // overloaded bullets). Try ONE LLM repair targeting them — but if it fails
  // or doesn't fully pass, we DO NOT bail: auto0 is already a renderable deck.
  agentLog("buildDeck.verifierFailed", {
    turnId: opts.turnId,
    slideIssueCount: verdict.slideIssues.length,
  });
  const repaired = await runDeckPlanner(inputs, opts, {
    issues: verdict.description,
    priorPlan: auto0,
  });

  let best = auto0;
  let bestIssues = verdict.slideIssues.length;
  if (repaired) {
    const autoRepaired = autoRepairDeckPlan(repaired);
    const repairedVerdict = verifyDeckPlan(autoRepaired);
    const renderable = autoRepaired.slides.length >= 3;
    if (repairedVerdict.ok) {
      if (renderable) {
        agentLog("buildDeck.planReady", {
          turnId: opts.turnId,
          slideCount: autoRepaired.slides.length,
        });
        return autoRepaired;
      }
    } else if (renderable && repairedVerdict.slideIssues.length < bestIssues) {
      best = autoRepaired;
      bestIssues = repairedVerdict.slideIssues.length;
    }
  } else {
    agentLog("buildDeck.repairPlannerNull", { turnId: opts.turnId });
  }

  // The plan still carries residual nits but is a full, renderable deck. SHIP
  // IT — an imperfect 14-slide deck beats the 3-slide stub every time.
  agentLog("buildDeck.shippedWithResidualIssues", {
    turnId: opts.turnId,
    slideCount: best.slides.length,
    residualSlideIssueCount: bestIssues,
  });
  return best;
}

/** Truncate to a max length without throwing on short strings. */
function clampMax(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Mine ExecSummary bullets from the answer envelope — the TL;DR plus the
 * strongest finding headlines. Each bullet is ≥ 8 / ≤ 400 chars to satisfy the
 * schema; the caller only emits an ExecSummary slide when ≥ 3 are derivable.
 */
function buildExecBullets(env: DashboardAnswerEnvelope | undefined): string[] {
  const bullets: string[] = [];
  const tldr = (env?.tldr ?? "").trim();
  if (tldr.length >= 8) bullets.push(clampMax(tldr, 400));
  for (const f of env?.findings ?? []) {
    if (bullets.length >= 6) break;
    const h = (f.headline ?? "").trim();
    if (h.length >= 8) {
      bullets.push(clampMax(f.magnitude ? `${h} [${f.magnitude}]` : h, 400));
    }
  }
  return bullets;
}

/** One ChartWithInsight slide for a chart, with a render-resolvable chartId. */
function chartInsightSlide(
  chart: ChartSpec,
  sheetIdx: number,
  chartIdx: number,
  ordinal: number
): SlideSpec {
  const spec = chart as ChartSpec & { keyInsight?: string };
  const title = (spec.title ?? "").trim() || `Chart ${ordinal}`;
  const ki = (spec.keyInsight ?? "").trim();
  const insight =
    ki.length >= 10
      ? clampMax(ki, 400)
      : clampMax(`Chart "${title}" — see the underlying data for detail.`, 400);
  // Prefer the chart's own insight HEADLINE as the action title (an actual
  // takeaway), falling back to the chart title. No mechanical "chart N of M"
  // suffix — that reads as filler, not a finding. Guard the schema's min-4-char
  // floor so a pathologically short title can't fail validation (and sink the
  // whole deck to the legacy stub).
  const headline = splitChartInsightLanes(ki).headline.trim();
  const candidate = headline.length >= 12 ? headline : title;
  const actionTitle = candidate.trim().length >= 4 ? candidate : `Chart ${ordinal}: ${candidate}`.trim();
  return {
    layout: LAYOUT_KIND.ChartWithInsight,
    actionTitle: clampMax(actionTitle, 280),
    speakerNotes: clampMax(`Presenter notes for "${title}" — review the chart before presenting.`, 1500),
    slots: { chartId: chartIdFor(sheetIdx, chartIdx), insight },
  };
}

/**
 * Rich deterministic fallback — used when the planner produced no usable plan.
 * Unlike the old 3-slide stub, this renders a REAL deck: TitleSlide + optional
 * ExecSummary / KpiRow (mined from `answerEnvelope`) + ONE ChartWithInsight per
 * chart (so every chart actually renders) + optional Recommendations +
 * Methodology. Pure + synchronous; the chart-id scheme mirrors
 * `resolveChartIdToSpec` exactly so the renderer resolves every slide. Capped at
 * the schema's 30-slide ceiling, with overflow folded into one Appendix slide.
 */
export function buildFallbackDeckPlan(
  dashboard: Dashboard,
  opts: BuildDeckOptions = {}
): SlideDeckPlan {
  const generatedAt = opts.generatedAt ?? new Date().toISOString().slice(0, 10);
  const confidentiality = opts.confidentiality ?? "Internal";
  const env = dashboard.answerEnvelope;

  // Mirror resolveChartIdToSpec's sheet ordering EXACTLY (sort by `order`;
  // legacy `charts[]` → a single "Overview" sheet at index 0) so every emitted
  // chartId resolves at render time.
  const sheets: DashboardSheet[] =
    dashboard.sheets && dashboard.sheets.length > 0
      ? [...dashboard.sheets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      : [
          {
            id: "default",
            name: "Overview",
            charts: dashboard.charts ?? [],
          } as DashboardSheet,
        ];
  const flatCharts: Array<{ chart: ChartSpec; sheetIdx: number; chartIdx: number }> = [];
  sheets.forEach((sheet, sheetIdx) => {
    (sheet.charts ?? []).forEach((chart, chartIdx) => {
      flatCharts.push({ chart, sheetIdx, chartIdx });
    });
  });
  const totalCharts = flatCharts.length;

  // ── Front chrome: Title (always) + ExecSummary? + KpiRow? ──
  const front: SlideSpec[] = [
    {
      layout: LAYOUT_KIND.TitleSlide,
      actionTitle: clampMax(`${dashboard.name || "Dashboard"} · ${totalCharts} charts captured ${generatedAt}`, 280),
      speakerNotes: "Cover slide. This deck was rendered directly from the dashboard's chart inventory.",
      slots: {
        subtitle: env?.tldr?.trim() ? clampMax(env.tldr.trim(), 400) : confidentiality,
        confidentiality,
      },
    },
  ];

  const bullets = buildExecBullets(env);
  if (bullets.length >= 3) {
    front.push({
      layout: LAYOUT_KIND.ExecSummary,
      actionTitle: clampMax(`${bullets.length} takeaways summarise this ${totalCharts}-chart dashboard`, 280),
      speakerNotes: "Top-line takeaways mined from the analysis summary; walk through each bullet.",
      slots: { bullets: bullets.slice(0, 6) },
    });
  }

  // Only LABELLED magnitudes become KPI tiles — an unlabelled tile renders as a
  // bare number with no context (the "470.92 / 257.02 / 677.86" look the user hit).
  const kpis = (env?.magnitudes ?? [])
    .filter((m) => (m.label ?? "").trim().length > 0)
    .slice(0, 5)
    .map((m) => ({ label: clampMax(m.label.trim(), 120), value: clampMax(String(m.value), 80) }));
  if (kpis.length >= 2) {
    front.push({
      layout: LAYOUT_KIND.KpiRow,
      actionTitle: clampMax(`${kpis.length} headline metrics frame this ${totalCharts}-chart review`, 280),
      speakerNotes: "Key magnitudes surfaced by the analysis, shown as KPI tiles.",
      slots: { kpis },
    });
  }

  // ── Back chrome: Recommendations? + Methodology (always, last) ──
  const recItems = (env?.recommendations ?? []).slice(0, 8).map((r) => ({
    action: clampMax((r.action ?? "").trim() || "Review this recommendation", 400),
    rationale: clampMax((r.rationale ?? "").trim() || "See the analysis for supporting detail.", 800),
    horizon: (["now", "this_quarter", "strategic"] as const).includes(r.horizon as never)
      ? (r.horizon as "now" | "this_quarter" | "strategic")
      : ("now" as const),
  }));
  const recSlide: SlideSpec | null =
    recItems.length >= 1
      ? {
          layout: LAYOUT_KIND.Recommendations,
          actionTitle: clampMax(`${recItems.length} recommended actions follow from this analysis`, 280),
          speakerNotes: "Recommended actions carried over from the analysis envelope.",
          slots: { items: recItems },
        }
      : null;

  const methodologyBody =
    env?.methodology && env.methodology.trim().length >= 20
      ? clampMax(env.methodology.trim(), 3500)
      : "Deterministic export — slides were rendered directly from the dashboard's chart inventory because the structured deck planner was unavailable. Each chart above is reproduced from its saved specification.";
  // Provenance signal: this fallback runs ONLY when the narrative deck planner
  // didn't deliver a usable plan, so always surface that here — otherwise a
  // silently-degraded "chart dump" deck looks intentional. (Ops also see
  // `buildDeck.plannerNull` in the logs.)
  const provenanceCaveat =
    "This deck was auto-composed from the dashboard's chart inventory; the narrative deck planner did not run for this export.";
  const caveats = [provenanceCaveat, ...(env?.caveats?.slice(0, 9).map((c) => clampMax(c, 400)) ?? [])];
  const methodologySlide: SlideSpec = {
    layout: LAYOUT_KIND.Methodology,
    actionTitle: clampMax(`Methodology · captured ${generatedAt} from ${totalCharts} charts`, 280),
    speakerNotes: "Closing slide describing how this deck was produced.",
    slots: {
      body: methodologyBody,
      caveats,
    },
  };

  // ── Chart slides, budgeted to the 30-slide schema cap ──
  const reservedFront = front.length;
  const reservedBack = (recSlide ? 1 : 0) + 1; // recommendations? + methodology
  const chartBudget = Math.max(0, 30 - reservedFront - reservedBack);

  const chartSlides: SlideSpec[] = [];
  let appendix: SlideSpec | null = null;
  if (totalCharts <= chartBudget) {
    flatCharts.forEach((fc, i) =>
      chartSlides.push(chartInsightSlide(fc.chart, fc.sheetIdx, fc.chartIdx, i + 1))
    );
  } else {
    const shown = Math.max(0, chartBudget - 1); // reserve one slot for the Appendix
    flatCharts
      .slice(0, shown)
      .forEach((fc, i) => chartSlides.push(chartInsightSlide(fc.chart, fc.sheetIdx, fc.chartIdx, i + 1)));
    const overflow = flatCharts.slice(shown);
    const titles = overflow.map((fc) => (fc.chart.title ?? "untitled").trim() || "untitled").join("; ");
    appendix = {
      layout: LAYOUT_KIND.Appendix,
      actionTitle: clampMax(`Appendix · ${overflow.length} additional charts in this dashboard`, 280),
      speakerNotes: "Charts beyond the 30-slide cap, listed here for completeness.",
      slots: { body: clampMax(`Additional charts not shown as individual slides: ${titles}`, 2000) },
    };
  }

  const slides: SlideSpec[] = [
    ...front,
    ...chartSlides,
    ...(appendix ? [appendix] : []),
    ...(recSlide ? [recSlide] : []),
    methodologySlide,
  ];

  const plan: SlideDeckPlan = {
    title: clampMax(dashboard.name || "Dashboard export", 200),
    subtitle: "Auto-rendered from the dashboard chart inventory.",
    generatedAt,
    confidentiality,
    preparedFor: opts.preparedFor,
    slides,
  };

  // Belt-and-braces: the rich fallback must NEVER fail schema validation. If a
  // defensive edge slips through, drop to the legacy minimal stub so the export
  // still ships rather than throwing.
  const parsed = slideDeckPlanSchema.safeParse(plan);
  if (!parsed.success) {
    agentLog("buildDeck.fallbackSchemaInvalid", {
      turnId: opts.turnId,
      error: parsed.error.message.slice(0, 200),
    });
    return legacyMinimalDeck(dashboard, generatedAt, confidentiality, opts.preparedFor);
  }
  return parsed.data;
}

/**
 * Absolute floor — the original 3-slide stub. Only reached if the rich fallback
 * somehow fails schema validation (it shouldn't). Kept so the export can never
 * throw: a user always gets a download.
 */
function legacyMinimalDeck(
  dashboard: Dashboard,
  generatedAt: string,
  confidentiality: string,
  preparedFor: string | undefined
): SlideDeckPlan {
  const allCharts = [
    ...(dashboard.sheets?.flatMap((s) => s.charts ?? []) ?? []),
    ...(dashboard.charts ?? []),
  ];
  const inventoryRows: Array<Array<string | number | null>> = allCharts
    .slice(0, 30)
    .map((c) => [c.title ?? "", c.type ?? "", c.x ?? null, c.y ?? null]);
  const totalCharts = allCharts.length;
  return {
    title: clampMax(dashboard.name || "Dashboard export", 200),
    subtitle: "Auto-rendered fallback — the deck planner could not compose a structured deck.",
    generatedAt,
    confidentiality,
    preparedFor,
    slides: [
      {
        layout: LAYOUT_KIND.TitleSlide,
        actionTitle: clampMax(`${dashboard.name || "Dashboard"} · ${totalCharts} charts captured ${generatedAt}`, 280),
        speakerNotes:
          "Fallback cover slide. The deck planner could not compose a structured deck for this dashboard; the next slide lists the chart inventory verbatim.",
        slots: { subtitle: confidentiality, confidentiality },
      },
      {
        layout: LAYOUT_KIND.TableSlide,
        actionTitle: clampMax(`Chart inventory · ${totalCharts} charts captured in this dashboard`, 280),
        speakerNotes: "Inventory slide listing every chart on the dashboard so reviewers can see what was captured.",
        slots: {
          caption: "Chart inventory",
          tableRef: {
            kind: "inline",
            columns: ["Title", "Type", "X", "Y"],
            rows: inventoryRows.length > 0 ? inventoryRows : [["No charts in this dashboard.", "", "", ""]],
          },
        },
      },
      {
        layout: LAYOUT_KIND.Methodology,
        actionTitle: clampMax(`Methodology · captured ${generatedAt} from ${totalCharts} charts`, 280),
        speakerNotes: "Closing slide explaining the fallback path; flagged so ops can investigate why the planner failed.",
        slots: {
          body:
            "This deck was rendered via the deterministic fallback path because the structured deck planner was unavailable. The chart inventory above mirrors the dashboard verbatim.",
          caveats: ["Action titles and speaker notes on this fallback are auto-generated; review before sharing externally."],
        },
      },
    ],
  };
}

export async function buildDashboardDeckPptx(
  dashboard: Dashboard,
  opts: BuildDeckOptions = {}
): Promise<Buffer> {
  const plan = (await buildAndVerifyDeckPlan(dashboard, opts)) ?? buildFallbackDeckPlan(dashboard, opts);
  return renderDeckPlanToPptxBuffer(plan, dashboard, {
    confidentiality: opts.confidentiality,
  });
}

/**
 * W-EXP-11 · PDF export — symmetric to PPTX. Plan → verify → render via
 * `@react-pdf/renderer`. Pure server-side, no Chromium.
 */
export async function buildDashboardDeckPdf(
  dashboard: Dashboard,
  opts: BuildDeckOptions = {}
): Promise<Buffer> {
  const plan = (await buildAndVerifyDeckPlan(dashboard, opts)) ?? buildFallbackDeckPlan(dashboard, opts);
  return renderDeckPlanToPdfBuffer(plan, dashboard, {
    confidentiality: opts.confidentiality,
    preparedFor: opts.preparedFor,
  });
}
