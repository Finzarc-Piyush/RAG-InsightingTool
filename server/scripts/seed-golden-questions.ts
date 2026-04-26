/**
 * Seed the golden-question corpus from the live `past_analyses` Cosmos
 * container. Picks thumbs-up turns with `outcome = "ok"`, strides across
 * different `shape` tags (when present via analysisBrief), and writes to
 * `server/tests/fixtures/golden-questions.json`.
 *
 * Run once after ~1 week of real traffic, then periodically re-seed when
 * patterns shift:
 *   npx tsx server/scripts/seed-golden-questions.ts --limit 30
 *
 * Exits 0 even when no rows are available — the fixture stays empty and the
 * A/B harness skips gracefully. Callers can then populate manually.
 */

import "../loadEnv.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PastAnalysisDoc } from "../shared/schema.ts";
import { waitForPastAnalysesContainer } from "../models/pastAnalysis.model.ts";
import {
  goldenCorpusSchema,
  type GoldenCorpus,
  type GoldenQuestion,
} from "../tests/fixtures/goldenQuestions.schema.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORPUS_PATH = path.join(
  __dirname,
  "..",
  "tests",
  "fixtures",
  "golden-questions.json"
);

interface CliArgs {
  limit: number;
  baselineConfig: string;
}

function parseArgs(argv: string[]): CliArgs {
  let limit = 30;
  let baselineConfig = "all-primary";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
    } else if (a === "--baseline" && argv[i + 1]) {
      baselineConfig = argv[++i];
    }
  }
  return { limit, baselineConfig };
}

function docToGolden(
  doc: PastAnalysisDoc,
  _shapeTag: GoldenQuestion["shape"]
): GoldenQuestion {
  return {
    id: doc.id,
    question: doc.question,
    shape: _shapeTag,
    tags: [],
    baselineAnswer: doc.answer,
    baselineChartCount: Array.isArray(doc.charts) ? doc.charts.length : 0,
    baselineOutcome: doc.outcome,
    baselineCostUsd: doc.costUsd,
    sessionId: doc.sessionId,
    dataVersion: doc.dataVersion,
    capturedAt: doc.createdAt,
  };
}

async function main(): Promise<void> {
  const { limit, baselineConfig } = parseArgs(process.argv.slice(2));
  console.log(
    `🌱 seed-golden-questions: limit=${limit} baseline="${baselineConfig}"`
  );

  let rows: PastAnalysisDoc[] = [];
  try {
    const container = await waitForPastAnalysesContainer(10, 500);
    const { resources } = await container.items
      .query<PastAnalysisDoc>({
        query: `SELECT * FROM c
                  WHERE c.outcome = 'ok'
                    AND c.feedback = 'up'
                  ORDER BY c.createdAt DESC
                  OFFSET 0 LIMIT @lim`,
        parameters: [{ name: "@lim", value: limit * 3 }],
      })
      .fetchAll();
    rows = resources;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ could not read past_analyses: ${msg}`);
    console.warn("   writing empty corpus — populate manually or try later.");
  }

  // Deduplicate by normalizedQuestion so near-identical repeats don't
  // dominate. Keep the most recent instance of each.
  const seen = new Set<string>();
  const picked: PastAnalysisDoc[] = [];
  for (const r of rows) {
    const key = r.normalizedQuestion;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(r);
    if (picked.length >= limit) break;
  }

  const questions: GoldenQuestion[] = picked.map((r) =>
    docToGolden(r, "other")
  );

  const corpus: GoldenCorpus = {
    version: 1,
    generatedAt: Date.now(),
    baselineConfig,
    questions,
  };

  // Validate the output before writing to avoid a malformed fixture poisoning CI.
  const parsed = goldenCorpusSchema.safeParse(corpus);
  if (!parsed.success) {
    console.error(`❌ generated corpus failed schema validation: ${parsed.error.message}`);
    process.exit(1);
  }

  await fs.writeFile(CORPUS_PATH, JSON.stringify(parsed.data, null, 2) + "\n");
  console.log(
    `✅ wrote ${questions.length} questions to ${path.relative(process.cwd(), CORPUS_PATH)}`
  );
  if (questions.length === 0) {
    console.log(
      "   (no eligible rows found — need at least some thumbs-up feedback; retry after live traffic.)"
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
