import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runMarketBasket,
  marketBasketArgsSchema,
  type MarketBasketArgs,
} from "../lib/agents/runtime/tools/marketBasketTool.js";

const fullArgs = (overrides: Partial<MarketBasketArgs> = {}): MarketBasketArgs => ({
  transactionIdColumn: "basket_id",
  itemColumn: "sku",
  minSupport: 0.1,
  minConfidence: 0.3,
  topN: 50,
  dimensionFilters: undefined,
  ...overrides,
});

/** Build a synthetic transaction stream. Each tuple is (basket_id, [skus]). */
function basketsToRows(
  baskets: Array<[string, string[]]>,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const [basket_id, skus] of baskets) {
    for (const sku of skus) rows.push({ basket_id, sku });
  }
  return rows;
}

describe("WT4 · runMarketBasket — basic rule extraction", () => {
  it("recovers a perfect A↔B co-occurrence with confidence 1 and lift > 1", () => {
    const rows = basketsToRows([
      ["t1", ["A", "B"]],
      ["t2", ["A", "B"]],
      ["t3", ["A", "B"]],
      ["t4", ["A", "B"]],
      ["t5", ["C"]],
      ["t6", ["C"]],
    ]);
    const result = runMarketBasket(rows, fullArgs({ minSupport: 0.1 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    // 4 of 6 baskets contain both A and B → support 0.667, confidence 1, lift = 1 / (4/6) = 1.5
    const aToB = tableRows.find((r) => r.antecedent === "A" && r.consequent === "B");
    assert.ok(aToB, "A → B rule emitted");
    assert.equal(aToB!.confidence, 1);
    assert.ok((aToB!.lift as number) > 1, "lift > 1 (positive association)");
  });

  it("emits BOTH directions of a frequent pair as separate rules", () => {
    const rows = basketsToRows([
      ["t1", ["A", "B"]],
      ["t2", ["A", "B"]],
      ["t3", ["A", "B"]],
      ["t4", ["A", "B"]],
    ]);
    const result = runMarketBasket(rows, fullArgs({ minSupport: 0.1 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const directions = (result.table.rows as Array<Record<string, unknown>>).filter(
      (r) => (r.antecedent === "A" && r.consequent === "B") ||
             (r.antecedent === "B" && r.consequent === "A"),
    );
    assert.equal(directions.length, 2, "both A→B and B→A");
  });

  it("computes support correctly as fraction of total transactions", () => {
    const rows = basketsToRows([
      ["t1", ["A", "B"]],
      ["t2", ["A", "B"]],
      ["t3", ["C"]],
      ["t4", ["C"]],
    ]);
    const result = runMarketBasket(rows, fullArgs({ minSupport: 0.1 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const aToB = (result.table.rows as Array<Record<string, unknown>>).find(
      (r) => r.antecedent === "A" && r.consequent === "B",
    );
    assert.equal(aToB!.support, 0.5, "2 of 4 baskets = 0.5");
  });

  it("computes lift as confidence / support(consequent)", () => {
    // 4 baskets: t1=AB, t2=AB, t3=A, t4=B
    // count(A) = 3, count(B) = 3, count(AB) = 2, T = 4
    // support(A→B) = 2/4 = 0.5
    // confidence(A→B) = count(AB)/count(A) = 2/3 = 0.667
    // support(B) = 3/4 = 0.75
    // lift(A→B) = 0.667 / 0.75 = 0.889
    const rows = basketsToRows([
      ["t1", ["A", "B"]],
      ["t2", ["A", "B"]],
      ["t3", ["A"]],
      ["t4", ["B"]],
    ]);
    const result = runMarketBasket(rows, fullArgs({ minSupport: 0.1, minConfidence: 0.5 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const aToB = (result.table.rows as Array<Record<string, unknown>>).find(
      (r) => r.antecedent === "A" && r.consequent === "B",
    );
    assert.ok(aToB);
    assert.equal(Math.round((aToB!.lift as number) * 1000), 889);
  });
});

describe("WT4 · runMarketBasket — support + confidence thresholds", () => {
  it("prunes pairs below minSupport", () => {
    const rows = basketsToRows([
      ["t1", ["A", "B"]], // AB appears once
      ...Array.from({ length: 19 }, (_, i) => [`t${i + 2}`, ["C", "D"]] as [string, string[]]),
    ]);
    // 20 baskets; minSupport=0.1 → minCount=2.
    // AB count=1 → below threshold → A→B not emitted
    // CD count=19 → above → C→D emitted
    const result = runMarketBasket(rows, fullArgs({ minSupport: 0.1 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rules = result.table.rows as Array<Record<string, unknown>>;
    const aToB = rules.find((r) => r.antecedent === "A" && r.consequent === "B");
    const cToD = rules.find((r) => r.antecedent === "C" && r.consequent === "D");
    assert.equal(aToB, undefined);
    assert.ok(cToD);
  });

  it("filters out rules below minConfidence", () => {
    // A appears in many baskets without B; A→B confidence is low.
    const rows = basketsToRows([
      ["t1", ["A", "B"]],
      ["t2", ["A"]],
      ["t3", ["A"]],
      ["t4", ["A"]],
      ["t5", ["B"]],
    ]);
    // count(A) = 4, count(B) = 2, count(AB) = 1
    // confidence(A→B) = 1/4 = 0.25 → below 0.3 threshold
    // confidence(B→A) = 1/2 = 0.50 → passes
    const result = runMarketBasket(rows, fullArgs({ minSupport: 0.1, minConfidence: 0.3 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rules = result.table.rows as Array<Record<string, unknown>>;
    const aToB = rules.find((r) => r.antecedent === "A" && r.consequent === "B");
    const bToA = rules.find((r) => r.antecedent === "B" && r.consequent === "A");
    assert.equal(aToB, undefined, "low-confidence A→B filtered");
    assert.ok(bToA, "B→A passes");
  });

  it("returns ok:false when no rules survive thresholds", () => {
    const rows = basketsToRows([
      ["t1", ["A"]],
      ["t2", ["B"]],
      ["t3", ["C"]],
    ]);
    const result = runMarketBasket(rows, fullArgs({ minSupport: 0.5 }));
    assert.equal(result.ok, false);
  });
});

describe("WT4 · runMarketBasket — sort + cap", () => {
  it("sorts rules by lift descending", () => {
    const rows = basketsToRows([
      ["t1", ["A", "B"]],
      ["t2", ["A", "B"]],
      ["t3", ["A", "B"]],
      ["t4", ["C", "D"]],
      ["t5", ["C"]],
      ["t6", ["D"]],
    ]);
    const result = runMarketBasket(rows, fullArgs({ minSupport: 0.1, minConfidence: 0.3 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const lifts = (result.table.rows as Array<Record<string, unknown>>).map(
      (r) => r.lift as number,
    );
    for (let i = 1; i < lifts.length; i++) {
      assert.ok(lifts[i - 1] >= lifts[i], `lift sorted desc at index ${i}`);
    }
  });

  it("caps results at topN", () => {
    const rows: Array<Record<string, unknown>> = [];
    // 5 frequent items → up to 5*4 = 20 directed rules.
    const items = ["A", "B", "C", "D", "E"];
    // Build baskets so every pair occurs ≥ 2 times in 10 baskets.
    for (let i = 0; i < 10; i++) {
      for (const it of items) rows.push({ basket_id: `t${i}`, sku: it });
    }
    const result = runMarketBasket(
      rows,
      fullArgs({ minSupport: 0.1, minConfidence: 0.3, topN: 5 }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.table.rows.length, 5);
    const payload = JSON.parse(result.numericPayload!);
    assert.ok(payload.totalRules > 5, "totalRules > capped");
  });
});

describe("WT4 · runMarketBasket — set semantics + filters", () => {
  it("treats duplicate (tx, item) rows as one occurrence (Set semantics)", () => {
    const rows = [
      { basket_id: "t1", sku: "A" },
      { basket_id: "t1", sku: "A" }, // duplicate row
      { basket_id: "t1", sku: "B" },
      { basket_id: "t2", sku: "A" },
      { basket_id: "t2", sku: "B" },
    ];
    const result = runMarketBasket(rows, fullArgs({ minSupport: 0.1 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const payload = JSON.parse(result.numericPayload!);
    assert.equal(payload.totalTransactions, 2, "duplicate (t1,A) collapsed");
  });

  it("applies dimensionFilters before basket construction", () => {
    const rows = [
      { basket_id: "t1", sku: "A", region: "North" },
      { basket_id: "t1", sku: "B", region: "North" },
      { basket_id: "t2", sku: "A", region: "North" },
      { basket_id: "t2", sku: "B", region: "North" },
      { basket_id: "t3", sku: "C", region: "South" },
      { basket_id: "t3", sku: "D", region: "South" },
    ];
    const result = runMarketBasket(
      rows,
      fullArgs({
        minSupport: 0.1,
        dimensionFilters: [{ column: "region", op: "in", values: ["North"] }],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rules = result.table.rows as Array<Record<string, unknown>>;
    // North only → A↔B. No C, D, or A↔C rules.
    assert.equal(rules.every((r) => r.antecedent !== "C" && r.consequent !== "C"), true);
  });
});

describe("WT4 · runMarketBasket — output shape + payload", () => {
  it("emits expected columns", () => {
    const rows = basketsToRows([
      ["t1", ["A", "B"]],
      ["t2", ["A", "B"]],
    ]);
    const result = runMarketBasket(rows, fullArgs({ minSupport: 0.1 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.table.columns, [
      "antecedent",
      "consequent",
      "support",
      "confidence",
      "lift",
      "count",
    ]);
  });

  it("numericPayload carries diagnostic metadata", () => {
    const rows = basketsToRows([
      ["t1", ["A", "B"]],
      ["t2", ["A", "B"]],
      ["t3", ["C"]],
    ]);
    const result = runMarketBasket(rows, fullArgs({ minSupport: 0.1 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const payload = JSON.parse(result.numericPayload!);
    assert.equal(payload.kind, "market_basket");
    assert.equal(payload.totalTransactions, 3);
    assert.ok(payload.frequentItems >= 2);
    assert.ok(payload.totalRules >= 1);
  });
});

describe("WT4 · runMarketBasket — failure modes", () => {
  it("returns ok:false for empty dataset", () => {
    const result = runMarketBasket([], fullArgs());
    assert.equal(result.ok, false);
  });

  it("returns ok:false when no rows match filters", () => {
    const rows = [{ basket_id: "t1", sku: "A", region: "North" }];
    const result = runMarketBasket(
      rows,
      fullArgs({
        dimensionFilters: [{ column: "region", op: "in", values: ["South"] }],
      }),
    );
    assert.equal(result.ok, false);
  });

  it("returns ok:false when fewer than 2 items meet minSupport", () => {
    const rows = basketsToRows([
      ["t1", ["A"]],
      ["t2", ["A"]],
      ["t3", ["B"]],
    ]);
    const result = runMarketBasket(rows, fullArgs({ minSupport: 0.5 }));
    assert.equal(result.ok, false);
  });
});

describe("WT4 · runMarketBasket — schema", () => {
  it("accepts valid args with defaults", () => {
    const parsed = marketBasketArgsSchema.safeParse({
      transactionIdColumn: "tx",
      itemColumn: "sku",
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.minSupport, 0.01);
      assert.equal(parsed.data.minConfidence, 0.3);
      assert.equal(parsed.data.topN, 50);
    }
  });

  it("rejects minSupport > 1", () => {
    const parsed = marketBasketArgsSchema.safeParse({
      transactionIdColumn: "tx",
      itemColumn: "sku",
      minSupport: 1.5,
    });
    assert.equal(parsed.success, false);
  });

  it("rejects unknown keys (.strict)", () => {
    const parsed = marketBasketArgsSchema.safeParse({
      transactionIdColumn: "tx",
      itemColumn: "sku",
      bogus: "x",
    });
    assert.equal(parsed.success, false);
  });
});
