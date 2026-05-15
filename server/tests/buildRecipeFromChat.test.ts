/**
 * Wave A4 · Recipe extractor contract.
 *
 * Pins the user→assistant turn pairing, intermediate-skip behavior, raw-vs-
 * final column derivation, and the persisted-computed-columns walk that
 * powers the upfront `applySessionTransformations` step at replay time.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRecipeFromChat,
  deriveRawColumnsFromDataSummary,
} from "../lib/automations/buildRecipeFromChat.js";
import type { DataSummary } from "../shared/schema.js";

const baseSummary: DataSummary = {
  rowCount: 100,
  columnCount: 4,
  columns: [
    { name: "Region", type: "string", sampleValues: ["North", "South"] },
    { name: "Date", type: "date", sampleValues: ["2024-01-01"] },
    { name: "Sales", type: "number", sampleValues: [100, 200] },
    { name: "Year · Date", type: "string", sampleValues: ["2024"] },
  ],
  numericColumns: ["Sales"],
  dateColumns: ["Date"],
  temporalFacetColumns: [
    {
      name: "Year · Date",
      grain: "year",
      sourceColumn: "Date",
    },
  ],
};

describe("Wave A4 · deriveRawColumnsFromDataSummary", () => {
  it("for non-wide datasets, returns columns minus temporal facets", () => {
    const raw = deriveRawColumnsFromDataSummary(baseSummary);
    assert.equal(raw.length, 3);
    assert.deepEqual(
      raw.map((c) => c.name),
      ["Region", "Date", "Sales"]
    );
  });

  it("for wide-format datasets, returns idColumns + meltedColumns", () => {
    const raw = deriveRawColumnsFromDataSummary({
      ...baseSummary,
      wideFormatTransform: {
        detected: true,
        shape: "pure_period",
        idColumns: ["Markets"],
        meltedColumns: ["Q1 23 Value Sales", "Q2 23 Value Sales"],
        periodCount: 2,
        periodColumn: "Period",
        periodIsoColumn: "PeriodIso",
        periodKindColumn: "PeriodKind",
        valueColumn: "Value",
      },
    });
    assert.equal(raw.length, 3);
    assert.equal(raw[0].name, "Markets");
    assert.equal(raw[0].type, "string");
    assert.equal(raw[1].name, "Q1 23 Value Sales");
    assert.equal(raw[1].type, "number");
  });

  it("returns empty list when summary is undefined", () => {
    assert.deepEqual(deriveRawColumnsFromDataSummary(undefined), []);
  });
});

describe("Wave A4 · buildRecipeFromChat", () => {
  const baseChat = {
    id: "session_123",
    sessionId: "session_123",
    username: "user@x.com",
    fileName: "marico.xlsx",
    dataSummary: baseSummary,
  };

  it("pairs user→assistant messages into turns and skips intermediates", () => {
    const result = buildRecipeFromChat(
      {
        ...baseChat,
        messages: [
          { role: "user", content: "What were total sales?" },
          {
            role: "assistant",
            content: "intermediate snapshot",
            isIntermediate: true,
          },
          {
            role: "assistant",
            content: "Final",
            agentTrace: {
              steps: [
                {
                  id: "s1",
                  tool: "execute_query_plan",
                  args: { plan: { groupBy: ["Region"] } },
                },
              ],
            },
            charts: [
              { type: "bar", title: "x", x: "Region", y: "Sales", data: [] },
            ],
          },
          { role: "user", content: "And by region?" },
          {
            role: "assistant",
            content: "Final 2",
            agentTrace: {
              steps: [
                { id: "s2", tool: "breakdown_ranking", args: {} },
              ],
            },
          },
        ],
      },
      { name: "Test automation" }
    );

    assert.equal(result.stats.capturedTurns, 2);
    assert.equal(result.stats.skippedIntermediates, 1);
    assert.equal(result.draft.recipe[0].ordinal, 0);
    assert.equal(result.draft.recipe[1].ordinal, 1);
    assert.equal(result.draft.recipe[0].planSteps.length, 1);
    assert.equal(result.draft.recipe[0].charts?.length, 1);
    assert.equal(result.stats.chartCount, 1);
  });

  it("captures persisted computed columns across turns", () => {
    const result = buildRecipeFromChat(
      {
        ...baseChat,
        messages: [
          { role: "user", content: "Add a SalesK column" },
          {
            role: "assistant",
            content: "Done",
            agentTrace: {
              steps: [
                {
                  id: "s1",
                  tool: "add_computed_columns",
                  args: {
                    persistToSession: true,
                    columns: [
                      { name: "SalesK", formula: "Sales / 1000" },
                    ],
                  },
                },
              ],
            },
          },
          { role: "user", content: "Now also add SalesM (ephemeral)" },
          {
            role: "assistant",
            content: "Done",
            agentTrace: {
              steps: [
                {
                  id: "s2",
                  tool: "add_computed_columns",
                  args: {
                    persistToSession: false,
                    columns: [
                      { name: "SalesM", formula: "Sales / 1000000" },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
      { name: "T" }
    );

    const captured =
      result.draft.sessionTransformations.sessionComputedColumns ?? [];
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, "SalesK");
    assert.equal(captured[0].formula, "Sales / 1000");
    assert.equal(captured[0].sourceTurnOrdinal, 0);
  });

  it("snapshots wideFormatTransform onto sessionTransformations", () => {
    const wf = {
      detected: true as const,
      shape: "pure_period" as const,
      idColumns: ["Markets"],
      meltedColumns: ["Q1 23 Value Sales"],
      periodCount: 1,
      periodColumn: "Period",
      periodIsoColumn: "PeriodIso",
      periodKindColumn: "PeriodKind",
      valueColumn: "Value",
    };
    const result = buildRecipeFromChat(
      {
        ...baseChat,
        dataSummary: { ...baseSummary, wideFormatTransform: wf },
        messages: [
          { role: "user", content: "Q?" },
          { role: "assistant", content: "A" },
        ],
      },
      { name: "T" }
    );
    assert.equal(
      result.draft.sessionTransformations.wideFormatTransform?.shape,
      "pure_period"
    );
  });

  it("counts dashboards (createdDashboardId or dashboardDraft)", () => {
    const result = buildRecipeFromChat(
      {
        ...baseChat,
        messages: [
          { role: "user", content: "Build dashboard" },
          {
            role: "assistant",
            content: "ok",
            createdDashboardId: "dashboard_x",
          },
          { role: "user", content: "Another" },
          {
            role: "assistant",
            content: "ok",
            dashboardDraft: { name: "Draft" },
          },
          { role: "user", content: "No dashboard" },
          { role: "assistant", content: "ok" },
        ],
      },
      { name: "T" }
    );
    assert.equal(result.stats.dashboardCount, 2);
    assert.equal(result.draft.recipe.length, 3);
  });

  it("orphan assistant (no preceding user) is skipped", () => {
    const result = buildRecipeFromChat(
      {
        ...baseChat,
        messages: [
          { role: "assistant", content: "Welcome to your data" },
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hi back" },
        ],
      },
      { name: "T" }
    );
    assert.equal(result.draft.recipe.length, 1);
    assert.equal(result.draft.recipe[0].question, "Hi");
  });
});
