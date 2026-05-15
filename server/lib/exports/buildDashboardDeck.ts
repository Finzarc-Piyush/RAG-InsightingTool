/**
 * W-EXP-7 · Top-level orchestrator: Dashboard → SlideDeckPlan → renderer.
 *
 * One function the controllers call:
 *   - buildDashboardDeckPptx(dashboard) → Buffer
 *   - buildDashboardDeckPdf(dashboard)  → Buffer  (lands in W-EXP-9/11)
 *
 * Pipeline:
 *   1. runDeckPlanner — Claude Opus 4.7, structured output, schema-validated
 *   2. verifyDeckPlan — deterministic gate (action titles, methodology
 *      placement, speaker notes, one-message-per-slide)
 *   3. On verifier fail: ONE repair round through runDeckPlanner with the
 *      issues + prior plan. Re-verify; if it still fails, fall through to
 *      a deterministic minimal deck so the user always gets a download.
 *   4. Render via the requested format's renderer.
 *
 * Falls back to a deterministic minimal deck when:
 *   - The planner returns null (network / schema fail unrecoverable)
 *   - The verifier still fails after one repair
 *   - The dashboard has no `answerEnvelope` AND no charts (nothing to plan)
 *
 * The fallback is a 3-slide deck (TitleSlide + summary table of charts +
 * Methodology placeholder). It's not pretty but it ships, and the agent
 * log captures the reason so ops can see why a particular dashboard
 * downgraded.
 */
import { agentLog } from "../agents/runtime/agentLogger.js";
import {
  runDeckPlanner,
  type DeckPlannerInputs,
  type DeckPlannerOptions,
} from "../agents/runtime/deckPlanner.js";
import { verifyDeckPlan } from "../agents/runtime/deckPlanVerifier.js";
import { LAYOUT_KIND, type SlideDeckPlan } from "../../shared/exportSchema.js";
import type { Dashboard } from "../../shared/schema.js";
import { renderDeckPlanToPptxBuffer } from "./pptx/render.js";
import { renderDeckPlanToPdfBuffer } from "./pdf/render.js";

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
      const msg = err instanceof Error ? err.message : String(err);
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
    const msg = err instanceof Error ? err.message : String(err);
    agentLog("buildDeck.domainContextLoadFailed", {
      turnId: opts.turnId,
      error: msg.slice(0, 200),
    });
  }

  // Initial planner call.
  let plan = await runDeckPlanner(inputs, opts);
  if (!plan) {
    agentLog("buildDeck.plannerNull", { turnId: opts.turnId });
    return null;
  }

  // Verify; repair once on failure.
  let verdict = verifyDeckPlan(plan);
  if (!verdict.ok) {
    agentLog("buildDeck.verifierFailed", {
      turnId: opts.turnId,
      slideIssueCount: verdict.slideIssues.length,
    });
    const repaired = await runDeckPlanner(inputs, opts, {
      issues: verdict.description,
      priorPlan: plan,
    });
    if (!repaired) {
      agentLog("buildDeck.repairPlannerNull", { turnId: opts.turnId });
      return null;
    }
    const repairedVerdict = verifyDeckPlan(repaired);
    if (!repairedVerdict.ok) {
      agentLog("buildDeck.verifierFailedAfterRepair", {
        turnId: opts.turnId,
        slideIssueCount: repairedVerdict.slideIssues.length,
      });
      return null;
    }
    plan = repaired;
    verdict = repairedVerdict;
  }
  agentLog("buildDeck.planReady", {
    turnId: opts.turnId,
    slideCount: plan.slides.length,
  });
  return plan;
}

/**
 * Last-resort minimal deck — 3 slides covering title, dashboard summary
 * (chart inventory as a TableSlide), and a methodology placeholder. Used
 * when both the planner and the repair round fail. Always renders without
 * needing any dashboard fields beyond `name` and `charts`.
 */
export function buildFallbackDeckPlan(
  dashboard: Dashboard,
  opts: BuildDeckOptions = {}
): SlideDeckPlan {
  const generatedAt = opts.generatedAt ?? new Date().toISOString().slice(0, 10);
  const allCharts = [
    ...(dashboard.sheets?.flatMap((s) => s.charts ?? []) ?? []),
    ...(dashboard.charts ?? []),
  ];
  const inventoryRows: Array<Array<string | number | null>> = allCharts
    .slice(0, 30)
    .map((c) => [c.title, c.type, c.x, c.y]);
  const totalCharts = allCharts.length;

  return {
    title: dashboard.name || "Dashboard export",
    subtitle: "Auto-rendered fallback — the deck planner could not compose a structured deck.",
    generatedAt,
    confidentiality: opts.confidentiality ?? "Internal",
    preparedFor: opts.preparedFor,
    slides: [
      {
        layout: LAYOUT_KIND.TitleSlide,
        actionTitle: `${dashboard.name} · ${totalCharts} charts captured ${generatedAt}`,
        speakerNotes:
          "Fallback cover slide. The deck planner could not compose a structured deck for this dashboard; the next slide lists the chart inventory verbatim.",
        slots: {
          subtitle: opts.confidentiality ?? "Internal",
          confidentiality: opts.confidentiality ?? "Internal",
        },
      },
      {
        layout: LAYOUT_KIND.TableSlide,
        actionTitle: `Chart inventory · ${totalCharts} charts captured in this dashboard`,
        speakerNotes: "Inventory slide listing every chart on the dashboard so reviewers can see what was captured.",
        slots: {
          caption: "Chart inventory",
          tableRef: {
            kind: "inline",
            columns: ["Title", "Type", "X", "Y"],
            rows:
              inventoryRows.length > 0
                ? inventoryRows
                : [["No charts in this dashboard.", "", "", ""]],
          },
        },
      },
      {
        layout: LAYOUT_KIND.Methodology,
        actionTitle: `Methodology · captured ${generatedAt} from ${totalCharts} charts`,
        speakerNotes: "Closing slide explaining the fallback path; flagged so ops can investigate why the planner failed.",
        slots: {
          body:
            "This deck was rendered via the deterministic fallback path because the LLM-driven planner could not produce a valid plan. The chart inventory above mirrors the dashboard verbatim. To diagnose, check the agent logs for `buildDeck.plannerNull` or `buildDeck.verifierFailedAfterRepair` events for this dashboard id.",
          caveats: [
            "Action titles and speaker notes on this fallback are auto-generated; review before sharing externally.",
          ],
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
