import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Stub Azure env BEFORE the dynamic import chain (applyDashboardChartInsights →
// generateInsightForCharts → insightGenerator → callLlm → openai) so module load
// doesn't crash. Cases are OFFLINE: the chat twin is copied by signature (no
// LLM), and the orphan grounds on empty rows so the engine returns its
// deterministic no-data message instead of calling the network.
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { applyEnrichedChartsToDashboard } = await import(
  "../lib/applyDashboardChartInsights.js"
);

/**
 * A3 guard · auto-created dashboards must be BORN INSIGHTED. After the helper
 * runs, NO chart on the dashboard draft may be left bare: charts with a chat
 * twin inherit the chat insight by signature; orphan sweep tiles (no twin) get
 * a freshly generated one.
 */
describe("applyEnrichedChartsToDashboard · born-insighted dashboards (A3)", () => {
  it("copies the chat insight onto the twin AND generates one for the orphan", async () => {
    const response: any = {
      charts: [
        {
          type: "bar",
          x: "Region",
          y: "Sales",
          title: "Sales by Region",
          keyInsight: "West leads on sales, clearly ahead of the rest.",
        },
      ],
      dashboardDraft: {
        sheets: [
          {
            charts: [
              // Twin of the chat chart (same axis signature) → copied, no LLM.
              { type: "bar", x: "Region", y: "Sales", title: "Sales by Region" },
              // Orphan sweep tile (no chat twin) → must be generated.
              {
                type: "bar",
                x: "Category",
                y: "Profit",
                title: "Profit by Category",
                _useAnalyticalDataOnly: true,
              },
            ],
          },
        ],
      },
    };

    await applyEnrichedChartsToDashboard({
      response,
      generation: {
        resolveRows: () => [],
        dataSummary: { rowCount: 0 } as any,
        context: {},
      },
    });

    const [twin, orphan] = response.dashboardDraft.sheets[0].charts;
    assert.equal(
      twin.keyInsight,
      "West leads on sales, clearly ahead of the rest.",
      "twin chart must inherit the chat answer's insight by signature",
    );
    assert.ok(
      typeof orphan.keyInsight === "string" && orphan.keyInsight.trim().length > 0,
      "orphan sweep tile must be generated — never ship bare",
    );
  });

  it("is a no-op-safe copy-only when no generation bundle is supplied", async () => {
    const response: any = {
      charts: [
        { type: "bar", x: "Region", y: "Sales", title: "T", keyInsight: "copied" },
      ],
      dashboardDraft: {
        sheets: [{ charts: [{ type: "bar", x: "Region", y: "Sales", title: "T" }] }],
      },
    };
    await applyEnrichedChartsToDashboard({ response });
    assert.equal(response.dashboardDraft.sheets[0].charts[0].keyInsight, "copied");
  });

  it("does not regenerate an orphan that already carries an insight (idempotent)", async () => {
    const response: any = {
      charts: [],
      dashboardDraft: {
        sheets: [
          {
            charts: [
              {
                type: "bar",
                x: "Category",
                y: "Profit",
                title: "Already insighted",
                keyInsight: "Hand-seeded insight to preserve.",
                _useAnalyticalDataOnly: true,
              },
            ],
          },
        ],
      },
    };
    await applyEnrichedChartsToDashboard({
      response,
      generation: { resolveRows: () => [], dataSummary: { rowCount: 0 } as any, context: {} },
    });
    assert.equal(
      response.dashboardDraft.sheets[0].charts[0].keyInsight,
      "Hand-seeded insight to preserve.",
    );
  });
});
