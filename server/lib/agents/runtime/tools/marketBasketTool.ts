/**
 * ============================================================================
 * marketBasketTool.ts — "what gets bought together" (the `run_market_basket` tool)
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Registers the `run_market_basket` tool, which does "market basket analysis"
 *   — finding products that tend to be purchased together. The input data has
 *   one row per (transaction, item); rows sharing a transaction id form a
 *   "basket". For each pair of frequently-bought items it computes three
 *   standard association-rule numbers:
 *     - support(i, j)    = how often both appear together / all transactions.
 *     - confidence(i→j)  = of baskets containing i, how often j is also there.
 *     - lift(i→j)        = confidence / support(j); lift > 1 means j is bought
 *                          MORE often when i is in the basket (a real "they go
 *                          together" signal, not just j being popular anyway).
 *   "Apriori" is the classic algorithm name; "1-LHS" means rules have a single
 *   item on the left ("if i, then j"), not combinations like "if a AND b".
 *
 * WHY IT MATTERS
 *   Answers "which one extra SKU should I recommend given this anchor SKU?" —
 *   the core cross-sell / bundling question for FMCG retail data. Pure
 *   JavaScript (no Python). It prunes infrequent items first (minSupport) so it
 *   stays fast even on million-row baskets.
 *
 * KEY PIECES
 *   - marketBasketArgsSchema — validates the request (transaction id column,
 *     item column, minSupport, minConfidence, topN, optional row filters).
 *   - AssociationRule — the shape of one emitted rule (antecedent, consequent,
 *     support, confidence, lift, count).
 *   - registerMarketBasketTool — registers the tool wrapper.
 *   - runMarketBasket — the pure transform: build baskets → count item & pair
 *     frequencies → emit + sort rules. Exported for tests / skill reuse.
 *
 * HOW IT CONNECTS
 *   Called by the agent act loop via the tool registry (toolRegistry.ts).
 *   Operates on `ctx.exec.data`. Pairs with `execute_query_plan` when the
 *   dataset needs prerequisite shaping before mining.
 */

import { z } from "zod";
import type { ToolRegistry, ToolResult, ToolRunContext } from "../toolRegistry.js";
import { agentLog } from "../agentLogger.js";

const dimensionFilterSchema = z
  .object({
    column: z.string().min(1),
    op: z.enum(["in", "not_in"]),
    values: z.array(z.string()).min(1),
    match: z.enum(["exact", "case_insensitive"]).optional(),
  })
  .strict();

export const marketBasketArgsSchema = z
  .object({
    /** Column that groups rows into transactions (basket_id, order_id). */
    transactionIdColumn: z.string().min(1),
    /** Item identifier column (SKU, product_name). */
    itemColumn: z.string().min(1),
    /** Minimum support fraction (0..1). Items below this in solo frequency
     *  are pruned before pair counting. */
    minSupport: z.number().min(0.0001).max(1).default(0.01),
    /** Minimum confidence fraction (0..1) for a rule to be emitted. */
    minConfidence: z.number().min(0.01).max(1).default(0.3),
    /** Cap on rules returned. Sort = lift desc, support desc on ties. */
    topN: z.number().int().min(1).max(500).default(50),
    /** Optional row-level prefilter. */
    dimensionFilters: z.array(dimensionFilterSchema).max(12).optional(),
  })
  .strict();

export type MarketBasketArgs = z.infer<typeof marketBasketArgsSchema>;

export interface AssociationRule {
  antecedent: string;
  consequent: string;
  support: number;
  confidence: number;
  lift: number;
  /** Raw count of transactions containing BOTH antecedent and consequent. */
  count: number;
}

function passesFilter(
  row: Record<string, unknown>,
  filter: { column: string; op: "in" | "not_in"; values: string[]; match?: "exact" | "case_insensitive" },
): boolean {
  const cell = row[filter.column];
  const cellStr = cell === null || cell === undefined ? "" : String(cell);
  const eq =
    filter.match === "case_insensitive"
      ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      : (a: string, b: string) => a === b;
  const matched = filter.values.some((v) => eq(cellStr, v));
  return filter.op === "in" ? matched : !matched;
}

export function registerMarketBasketTool(registry: ToolRegistry) {
  registry.register(
    "run_market_basket",
    marketBasketArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx: ToolRunContext, args: Record<string, unknown>) => {
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "run_market_basket is only available in analysis mode.",
        };
      }
      const parsed = marketBasketArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for run_market_basket: ${parsed.error.message}`,
        };
      }
      const result = runMarketBasket(ctx.exec.data, parsed.data);
      if (!result.ok) return result;
      agentLog("run_market_basket.done", {
        transactionIdColumn: parsed.data.transactionIdColumn,
        itemColumn: parsed.data.itemColumn,
        minSupport: parsed.data.minSupport,
        minConfidence: parsed.data.minConfidence,
        rulesReturned: result.table?.rows.length ?? 0,
      });
      return result;
    },
    {
      description:
        "Mine 1-LHS association rules (antecedent → consequent) from transaction baskets. Returns support / confidence / lift per rule, sorted by lift. Lift > 1 means the consequent is more likely when the antecedent is in the basket. Pure-Node (apriori prefix); pairs with execute_query_plan when the dataset needs prerequisite shaping.",
      argsHelp:
        '{"transactionIdColumn":"<col>","itemColumn":"<col>","minSupport":0.01,"minConfidence":0.3,"topN":50,"dimensionFilters"?:[{"column":"<col>","op":"in"|"not_in","values":["..."]}]}',
    },
  );
}

/** Pure transform — exported for tests + skill reuse. No I/O. */
export function runMarketBasket(
  rows: Array<Record<string, unknown>>,
  args: MarketBasketArgs,
): ToolResult {
  if (!rows || rows.length === 0) {
    return { ok: false, summary: "run_market_basket: dataset is empty." };
  }
  const filtered = rows.filter((row) =>
    (args.dimensionFilters ?? []).every((f) => passesFilter(row, f)),
  );
  if (filtered.length === 0) {
    return {
      ok: false,
      summary: "run_market_basket: no rows match the supplied filters.",
    };
  }

  // 1. Build per-transaction item sets. A repeated (tx, item) row is
  //    collapsed (Set semantics) — apriori is over distinct items per
  //    basket, not row counts.
  const transactions = new Map<string, Set<string>>();
  for (const row of filtered) {
    const txRaw = row[args.transactionIdColumn];
    const itemRaw = row[args.itemColumn];
    if (txRaw === null || txRaw === undefined || txRaw === "") continue;
    if (itemRaw === null || itemRaw === undefined || itemRaw === "") continue;
    const tx = String(txRaw);
    const item = String(itemRaw);
    let basket = transactions.get(tx);
    if (!basket) {
      basket = new Set();
      transactions.set(tx, basket);
    }
    basket.add(item);
  }

  const T = transactions.size;
  if (T === 0) {
    return {
      ok: false,
      summary: "run_market_basket: no valid (transaction, item) pairs.",
    };
  }
  // Filter out singleton transactions — they cannot contribute to pair counts.
  // We still keep them in the support denominator only if they hold relevant
  // items; but since they hold no pair, they only affect frequency counts.
  // For correctness, keep them.

  // 2. Solo item frequency.
  const itemCounts = new Map<string, number>();
  for (const basket of transactions.values()) {
    for (const item of basket) {
      itemCounts.set(item, (itemCounts.get(item) ?? 0) + 1);
    }
  }

  const minCount = Math.max(1, Math.ceil(args.minSupport * T));
  const frequentItems = Array.from(itemCounts.entries())
    .filter(([, count]) => count >= minCount)
    .map(([item]) => item);

  if (frequentItems.length < 2) {
    return {
      ok: false,
      summary: `run_market_basket: fewer than 2 items meet minSupport=${args.minSupport} (${frequentItems.length} frequent / ${itemCounts.size} total).`,
    };
  }

  // 3. Pair counting. Walk each basket once, emit pairs from the
  //    intersection of basket × frequentItems. Use Set lookup for
  //    membership test to stay O(|basket|²) per basket on the small
  //    frequent-item subset.
  const frequentSet = new Set(frequentItems);
  const pairCounts = new Map<string, number>();
  function pairKey(a: string, b: string): string {
    // Order-independent canonical key for pair counting.
    return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  }
  for (const basket of transactions.values()) {
    const items = Array.from(basket).filter((i) => frequentSet.has(i));
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const k = pairKey(items[i], items[j]);
        pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
      }
    }
  }

  // 4. Emit directed rules a → b for each frequent pair, computing
  //    support, confidence, lift. Filter by minConfidence.
  const rules: AssociationRule[] = [];
  for (const [k, count] of pairCounts) {
    if (count < minCount) continue;
    const [a, b] = k.split("\u0000");
    const supA = (itemCounts.get(a) ?? 0) / T;
    const supB = (itemCounts.get(b) ?? 0) / T;
    const supAB = count / T;

    // a → b
    const confAB = supAB / supA;
    if (confAB >= args.minConfidence) {
      rules.push({
        antecedent: a,
        consequent: b,
        support: supAB,
        confidence: confAB,
        lift: supB === 0 ? 0 : confAB / supB,
        count,
      });
    }
    // b → a (independent rule).
    const confBA = supAB / supB;
    if (confBA >= args.minConfidence) {
      rules.push({
        antecedent: b,
        consequent: a,
        support: supAB,
        confidence: confBA,
        lift: supA === 0 ? 0 : confBA / supA,
        count,
      });
    }
  }

  if (rules.length === 0) {
    return {
      ok: false,
      summary: `run_market_basket: no rules met minConfidence=${args.minConfidence}.`,
    };
  }

  // 5. Sort by lift desc, support desc on ties, count desc as final tiebreak.
  rules.sort((a, b) => {
    if (b.lift !== a.lift) return b.lift - a.lift;
    if (b.support !== a.support) return b.support - a.support;
    return b.count - a.count;
  });

  const capped = rules.slice(0, args.topN);

  const tableRows = capped.map((r) => ({
    antecedent: r.antecedent,
    consequent: r.consequent,
    support: round(r.support, 4),
    confidence: round(r.confidence, 4),
    lift: round(r.lift, 4),
    count: r.count,
  }));

  const summary =
    `${rules.length} rule(s) met confidence threshold; top ${capped.length} returned. ` +
    `Strongest: ${capped[0].antecedent} → ${capped[0].consequent} (lift=${tableRows[0].lift}, conf=${tableRows[0].confidence}, support=${tableRows[0].support}).`;

  return {
    ok: true,
    summary,
    table: {
      columns: ["antecedent", "consequent", "support", "confidence", "lift", "count"],
      rows: tableRows,
    },
    numericPayload: JSON.stringify({
      kind: "market_basket",
      transactionIdColumn: args.transactionIdColumn,
      itemColumn: args.itemColumn,
      minSupport: args.minSupport,
      minConfidence: args.minConfidence,
      totalTransactions: T,
      frequentItems: frequentItems.length,
      candidatePairs: pairCounts.size,
      totalRules: rules.length,
      cappedTo: capped.length,
    }),
  };
}

function round(v: number, digits: number): number {
  if (!Number.isFinite(v)) return v;
  const k = Math.pow(10, digits);
  return Math.round(v * k) / k;
}
