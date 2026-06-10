import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findRelevantPriorResult,
  loadPriorArtifactRows,
} from "../lib/pastAnalysisRecall.js";
import type {
  PastAnalysisDoc,
  PastAnalysisPivotArtifact,
} from "../shared/schema.js";

/**
 * Part 3.2 · the recall lib that lets a follow-up build on a prior turn's
 * FULL stored result instead of re-deriving it.
 */

function inlineArtifact(
  over: Partial<PastAnalysisPivotArtifact> & {
    rows: Record<string, unknown>[];
  }
): PastAnalysisPivotArtifact {
  const { rows, ...rest } = over;
  return {
    artifactId: rest.artifactId ?? "art-1",
    plan: {},
    pivotDefaults: {},
    columnHeaders: rest.columnHeaders ?? Object.keys(rows[0] ?? {}),
    rowCount: rows.length,
    storage: { kind: "inline", rows },
    ...(rest.questionContext ? { questionContext: rest.questionContext } : {}),
  } as PastAnalysisPivotArtifact;
}

function doc(
  question: string,
  artifacts: PastAnalysisPivotArtifact[],
  createdAt = 1
): PastAnalysisDoc {
  return {
    id: `s__t${createdAt}`,
    sessionId: "s",
    userId: "u",
    turnId: `t${createdAt}`,
    question,
    answer: `answer for ${question}`,
    createdAt,
    pivotArtifacts: artifacts,
  } as unknown as PastAnalysisDoc;
}

describe("findRelevantPriorResult", () => {
  const docs: PastAnalysisDoc[] = [
    doc("Top 10 products by sales", [
      inlineArtifact({
        artifactId: "products",
        columnHeaders: ["Product", "Sales_sum"],
        questionContext: "top products by sales",
        rows: [
          { Product: "Widget", Sales_sum: 900 },
          { Product: "Gadget", Sales_sum: 700 },
        ],
      }),
    ], 2),
    doc("Adherence rate by cluster", [
      inlineArtifact({
        artifactId: "clusters",
        columnHeaders: ["Cluster Name", "adherence_rate"],
        questionContext: "pjp adherence by cluster",
        rows: [{ "Cluster Name": "North", adherence_rate: 0.8 }],
      }),
    ], 1),
  ];

  it("recalls the best-matching prior result's full rows", async () => {
    const match = await findRelevantPriorResult(
      "s",
      "the top products by sales from earlier",
      { lister: async () => docs }
    );
    assert.ok(match);
    assert.equal(match!.artifactId, "products");
    assert.equal(match!.rowCount, 2);
    assert.deepEqual(match!.columns, ["Product", "Sales_sum"]);
    assert.equal(match!.rows.length, 2);
    assert.equal(match!.question, "Top 10 products by sales");
  });

  it("picks the cluster result when the query is about adherence", async () => {
    const match = await findRelevantPriorResult("s", "adherence by cluster", {
      lister: async () => docs,
    });
    assert.ok(match);
    assert.equal(match!.artifactId, "clusters");
  });

  it("returns null when nothing matches", async () => {
    const match = await findRelevantPriorResult("s", "revenue by quarter region", {
      lister: async () => docs,
    });
    assert.equal(match, null);
  });

  it("returns null for an empty/stopword-only query", async () => {
    const match = await findRelevantPriorResult("s", "show me the", {
      lister: async () => docs,
    });
    assert.equal(match, null);
  });

  it("uses the injected rowLoader for blob-backed artifacts", async () => {
    const blobDoc = doc("Sales by region", [
      {
        artifactId: "region-blob",
        plan: {},
        pivotDefaults: {},
        columnHeaders: ["Region", "Sales_sum"],
        rowCount: 3,
        storage: { kind: "blob", blobName: "past-analyses-pivots/region-blob.json", bytes: 999 },
        questionContext: "sales by region",
      } as PastAnalysisPivotArtifact,
    ]);
    const match = await findRelevantPriorResult("s", "sales by region", {
      lister: async () => [blobDoc],
      rowLoader: async () => [
        { Region: "East", Sales_sum: 1 },
        { Region: "West", Sales_sum: 2 },
        { Region: "South", Sales_sum: 3 },
      ],
    });
    assert.ok(match);
    assert.equal(match!.rows.length, 3);
    assert.equal(match!.rows[0]!.Region, "East");
  });
});

describe("loadPriorArtifactRows", () => {
  it("returns inline rows verbatim without a blob fetch", async () => {
    const rows = [{ a: 1 }, { a: 2 }];
    const out = await loadPriorArtifactRows(
      inlineArtifact({ rows })
    );
    assert.deepEqual(out, rows);
  });
});
