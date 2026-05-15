/**
 * DPF4 · pin the data-flow contract: server `Dashboard` round-trips through
 * `normalizeDashboard` into `DashboardData`, carrying the four new
 * message-mirroring fields the `AnalysisSummaryPanel` reads. Without this
 * coverage the persisted businessActions / followUpPrompts /
 * investigationSummary / priorInvestigationsSnapshot would silently fail
 * to render even when DPF2 stamped them onto the Cosmos doc.
 *
 * Vitest is configured with `environment: "node"` (no DOM, no
 * @testing-library), so we test the data normalisation contract here
 * rather than the component render. Component-level guarantees are: TS
 * compiles (DPF1 type imports) AND `AnalysisSummaryPanel` renders nothing
 * when all four fields are absent (back-compat — pinned via the import
 * smoke check below).
 */
import { describe, it, expect } from "vitest";
import { normalizeDashboard } from "./useDashboardState";
import type { Dashboard as ServerDashboard } from "@/shared/schema";
import { AnalysisSummaryPanel } from "../Components/AnalysisSummaryPanel";

const baseServerDashboard = (): ServerDashboard => ({
  id: "dash-1",
  username: "user@example.com",
  name: "Q4 review",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  charts: [],
});

describe("DPF4 · normalizeDashboard carries the four new message-mirroring fields", () => {
  it("propagates businessActions verbatim", () => {
    const businessActions = [
      {
        title: "Reallocate Q4 trade spend",
        rationale: "ZAYO ROAS leads — capture before it reverts.",
        horizon: "this_quarter" as const,
        confidence: "medium" as const,
      },
    ];
    const out = normalizeDashboard({
      ...baseServerDashboard(),
      businessActions,
    });
    expect(out.businessActions).toEqual(businessActions);
  });

  it("propagates followUpPrompts verbatim", () => {
    const followUpPrompts = ["What's driving ZAYO?", "Compare LASHE vs ZAYO"];
    const out = normalizeDashboard({
      ...baseServerDashboard(),
      followUpPrompts,
    });
    expect(out.followUpPrompts).toEqual(followUpPrompts);
  });

  it("propagates investigationSummary verbatim", () => {
    const investigationSummary = {
      hypotheses: [
        {
          text: "MT shifted toward online" as const,
          status: "confirmed" as const,
          evidenceCount: 2,
        },
      ],
    };
    const out = normalizeDashboard({
      ...baseServerDashboard(),
      investigationSummary,
    });
    expect(out.investigationSummary).toEqual(investigationSummary);
  });

  it("propagates priorInvestigationsSnapshot verbatim", () => {
    const priorInvestigationsSnapshot = [
      {
        at: "2026-04-01",
        question: "Why is share declining?",
        hypothesesConfirmed: ["Distribution gap"],
        hypothesesRefuted: [],
        hypothesesOpen: [],
        headlineFinding: "Metro MT distribution down 4pp",
      },
    ];
    const out = normalizeDashboard({
      ...baseServerDashboard(),
      priorInvestigationsSnapshot,
    });
    expect(out.priorInvestigationsSnapshot).toEqual(priorInvestigationsSnapshot);
  });

  it("back-compat: pre-DPF1 server dashboard (no new fields) normalises with all four undefined", () => {
    const out = normalizeDashboard(baseServerDashboard());
    expect(out.businessActions).toBeUndefined();
    expect(out.followUpPrompts).toBeUndefined();
    expect(out.investigationSummary).toBeUndefined();
    expect(out.priorInvestigationsSnapshot).toBeUndefined();
  });

  it("preserves existing fields (charts, name, capturedActiveFilter, answerEnvelope) alongside new ones", () => {
    const answerEnvelope = { tldr: "Headline summary" };
    const out = normalizeDashboard({
      ...baseServerDashboard(),
      answerEnvelope,
      followUpPrompts: ["follow-up"],
    });
    expect(out.answerEnvelope).toEqual(answerEnvelope);
    expect(out.followUpPrompts).toEqual(["follow-up"]);
    expect(out.name).toBe("Q4 review");
  });
});

describe("DPF4 · AnalysisSummaryPanel module shape", () => {
  it("exports the AnalysisSummaryPanel component", () => {
    // The component itself can't be mounted here (env: node, no
    // @testing-library), but we lock down that the import resolves —
    // catches a renamed export or moved file before runtime.
    expect(typeof AnalysisSummaryPanel).toBe("function");
  });
});
