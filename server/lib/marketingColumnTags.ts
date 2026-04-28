/**
 * Heuristic tagger for marketing-mix datasets. Pure function over DataSummary —
 * no LLM, no I/O — so it can be called cheaply by the planner and by the
 * run_budget_optimizer tool to seed schema arguments.
 *
 * Three things matter for budget reallocation:
 *   - which numeric columns are channel SPEND
 *   - which numeric column is the OUTCOME (revenue / sales / conversions)
 *   - which column is the TIME axis (date, weekly grain or finer)
 *
 * We also detect long-format data (a single spend column plus a `channel`
 * categorical) so the caller can pivot before fitting.
 */
import type { DataSummary } from "../shared/schema.js";

export type MarketingColumnRole =
  | "spend"
  | "outcome"
  | "channel_dimension"
  | "time"
  | "unrelated";

export interface MarketingColumnTag {
  name: string;
  role: MarketingColumnRole;
  confidence: number;
  reason: string;
}

export type MarketingDataShape = "wide" | "long" | "unknown";

export interface MarketingColumnTagging {
  tags: MarketingColumnTag[];
  spendColumns: string[];
  outcomeColumn?: string;
  outcomeCandidates: string[];
  timeColumn?: string;
  channelDimension?: string;
  shape: MarketingDataShape;
  caveats: string[];
}

const SPEND_TOKENS = new Set([
  "spend", "spends", "spending", "cost", "costs", "invest", "investment", "investments",
  "budget", "budgets", "outlay", "outlays", "expense", "expenses", "expenditure", "expenditures",
]);
const CHANNEL_TOKENS = new Set([
  "tv", "digital", "social", "search", "display", "video", "youtube", "meta", "facebook",
  "instagram", "google", "programmatic", "affiliate", "email", "sms", "ooh", "outdoor",
  "print", "radio", "influencer", "sponsorship", "trade", "promo", "content", "seo", "sem",
  "cpm", "cpc", "ad", "ads", "adwords",
]);
const OUTCOME_TOKENS = new Set([
  "revenue", "sales", "conversion", "conversions", "lead", "leads", "signup", "signups",
  "install", "installs", "order", "orders", "gmv", "nsv", "booking", "bookings",
  "trial", "trials", "click", "clicks", "impression", "impressions", "reach",
  "engagement", "view", "views", "units", "qty", "quantity",
]);
const STRONG_OUTCOME_TOKENS = new Set([
  "revenue", "sales", "gmv", "nsv", "conversion", "conversions", "orders",
]);

const CHANNEL_DIM_NAME_RX =
  /^(channel|media[_\s-]?channel|platform|source|ad[_\s-]?source|medium|campaign[_\s-]?type|marketing[_\s-]?channel)$/i;

function tokenize(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function hasAnyToken(name: string, set: ReadonlySet<string>): boolean {
  return tokenize(name).some((t) => set.has(t));
}

const MONEY_VALUE_RX = /^[\s\$₹€£]?-?\d{1,3}(,\d{3})*(\.\d+)?$|^[\s\$₹€£]?-?\d+(\.\d+)?$/;

function isMoneyFormatted(samples: ReadonlyArray<string | number | null>): boolean {
  let positives = 0;
  let total = 0;
  for (const s of samples) {
    if (s === null || s === undefined) continue;
    total += 1;
    const txt = typeof s === "number" ? String(s) : s;
    if (MONEY_VALUE_RX.test(txt.trim())) positives += 1;
  }
  return total > 0 && positives / total >= 0.6;
}

function isLowCardinalityCategorical(
  topValuesCount: number | undefined,
  rowCount: number
): boolean {
  if (!topValuesCount) return false;
  if (topValuesCount < 2 || topValuesCount > 30) return false;
  if (rowCount > 0 && topValuesCount / rowCount > 0.5) return false;
  return true;
}

function rankOutcomeCandidates(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const aStrong = hasAnyToken(a, STRONG_OUTCOME_TOKENS) ? 1 : 0;
    const bStrong = hasAnyToken(b, STRONG_OUTCOME_TOKENS) ? 1 : 0;
    if (aStrong !== bStrong) return bStrong - aStrong;
    return a.localeCompare(b);
  });
}

export function tagMarketingColumns(summary: DataSummary): MarketingColumnTagging {
  const tags: MarketingColumnTag[] = [];
  const numericSet = new Set(summary.numericColumns);
  const dateSet = new Set(summary.dateColumns);

  const spendColumns: string[] = [];
  const outcomeCandidates: string[] = [];
  let channelDimension: string | undefined;

  for (const col of summary.columns) {
    const name = col.name;
    const isNumeric = numericSet.has(name);
    const isDate = dateSet.has(name);

    if (isDate) {
      tags.push({ name, role: "time", confidence: 0.9, reason: "date column" });
      continue;
    }

    const nameMatchesSpend = hasAnyToken(name, SPEND_TOKENS);
    const nameMatchesChannelToken = hasAnyToken(name, CHANNEL_TOKENS);
    const nameMatchesOutcome = hasAnyToken(name, OUTCOME_TOKENS);
    const nameIsChannelDim = CHANNEL_DIM_NAME_RX.test(name.trim());

    if (isNumeric && (nameMatchesSpend || (nameMatchesChannelToken && isMoneyFormatted(col.sampleValues)))) {
      const confidence = nameMatchesSpend && nameMatchesChannelToken ? 0.95 : nameMatchesSpend ? 0.85 : 0.7;
      tags.push({
        name,
        role: "spend",
        confidence,
        reason: nameMatchesSpend
          ? `name matches spend keyword`
          : `channel token + money-formatted samples`,
      });
      spendColumns.push(name);
      continue;
    }

    if (isNumeric && nameMatchesOutcome) {
      const isStrong = hasAnyToken(name, STRONG_OUTCOME_TOKENS);
      tags.push({
        name,
        role: "outcome",
        confidence: isStrong ? 0.9 : 0.7,
        reason: isStrong ? `name matches strong outcome keyword` : `name matches outcome keyword`,
      });
      outcomeCandidates.push(name);
      continue;
    }

    if (!isNumeric && nameIsChannelDim) {
      const lowCard = isLowCardinalityCategorical(col.topValues?.length, summary.rowCount);
      if (!channelDimension) channelDimension = name;
      tags.push({
        name,
        role: "channel_dimension",
        confidence: lowCard ? 0.85 : 0.6,
        reason: lowCard
          ? `categorical name + low cardinality`
          : `categorical name match`,
      });
      continue;
    }

    tags.push({ name, role: "unrelated", confidence: 0.5, reason: "no marketing-keyword match" });
  }

  const ranked = rankOutcomeCandidates(outcomeCandidates);
  const outcomeColumn = ranked[0];
  const timeColumn = summary.dateColumns[0];

  let shape: MarketingDataShape = "unknown";
  if (spendColumns.length >= 2) shape = "wide";
  else if (spendColumns.length === 1 && channelDimension) shape = "long";

  const caveats: string[] = [];
  if (spendColumns.length === 0) {
    caveats.push(
      "No spend columns detected. Looking for column names containing 'spend', 'cost', 'invest', or 'budget'."
    );
  }
  if (!outcomeColumn) {
    caveats.push(
      "No outcome metric detected. Looking for column names like 'revenue', 'sales', 'conversions', 'orders'."
    );
  }
  if (!timeColumn) {
    caveats.push("No date column detected. Budget reallocation requires a time series.");
  }
  if (shape === "long") {
    caveats.push(
      `Data appears to be long-format (channel dimension '${channelDimension}'). Pivot before fitting.`
    );
  }

  return {
    tags,
    spendColumns,
    outcomeColumn,
    outcomeCandidates: ranked,
    timeColumn,
    channelDimension,
    shape,
    caveats,
  };
}

/**
 * Cheap "is this dataset plausibly a marketing-mix dataset?" check used by the
 * planner to decide whether the budget_reallocation question shape is even
 * applicable.
 */
export function looksLikeMarketingMixDataset(summary: DataSummary): boolean {
  const t = tagMarketingColumns(summary);
  if (!t.timeColumn) return false;
  if (!t.outcomeColumn) return false;
  if (t.spendColumns.length >= 2) return true;
  if (t.spendColumns.length === 1 && t.channelDimension) return true;
  return false;
}
