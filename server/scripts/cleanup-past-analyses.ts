/**
 * W5.6 · Nightly cleanup of stale past-analysis rows.
 *
 * Two-axis purge:
 *   - TTL: rows older than `--ttl-days` (default 90) are deleted.
 *   - Per-session version retention: rows whose `dataVersion` is older than the
 *     newest `--keep-versions` (default 2) for that session are deleted.
 *
 * Both Cosmos rows AND AI Search docs are removed. AI Search failures are
 * logged but don't stop Cosmos deletion (Cosmos is the source of truth; the
 * filter on the index naturally excludes orphaned vectors via dataVersion).
 *
 * Usage:
 *   npx tsx server/scripts/cleanup-past-analyses.ts                 # defaults
 *   npx tsx server/scripts/cleanup-past-analyses.ts --ttl-days 30
 *   npx tsx server/scripts/cleanup-past-analyses.ts --session sess_abc
 *   npx tsx server/scripts/cleanup-past-analyses.ts --dry-run
 *
 * Cron-friendly: prints a one-line summary at the end suitable for log parsing.
 */

import "../loadEnv.ts";
import {
  findPurgeCandidates,
  deletePastAnalysisDoc,
} from "../models/pastAnalysis.model.ts";
import { deletePastAnalysisById } from "../lib/rag/pastAnalysesStore.ts";

interface CliArgs {
  ttlDays: number;
  keepVersions: number;
  sessionId?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let ttlDays = 90;
  let keepVersions = 2;
  let sessionId: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ttl-days" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) ttlDays = Math.floor(n);
    } else if (a === "--keep-versions" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 1) keepVersions = Math.floor(n);
    } else if (a === "--session" && argv[i + 1]) {
      sessionId = argv[++i];
    } else if (a === "--dry-run") {
      dryRun = true;
    }
  }
  return { ttlDays, keepVersions, sessionId, dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `🧹 cleanup-past-analyses: ttlDays=${args.ttlDays} keepVersions=${args.keepVersions} session=${args.sessionId ?? "*"} dryRun=${args.dryRun}`
  );

  let candidates: Awaited<ReturnType<typeof findPurgeCandidates>>;
  try {
    candidates = await findPurgeCandidates({
      sessionId: args.sessionId,
      maxAgeMs: args.ttlDays * 24 * 60 * 60 * 1000,
      keepLatestNVersions: args.keepVersions,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ failed to enumerate purge candidates: ${msg}`);
    process.exit(1);
  }

  console.log(`🧮 ${candidates.length} candidate row(s) to remove`);
  if (args.dryRun || candidates.length === 0) {
    for (const c of candidates.slice(0, 20)) {
      console.log(
        `   would delete id=${c.id} session=${c.sessionId} v${c.dataVersion} created=${new Date(c.createdAt).toISOString()}`
      );
    }
    if (candidates.length > 20) {
      console.log(`   ... and ${candidates.length - 20} more`);
    }
    process.exit(0);
  }

  let cosmosOk = 0;
  let cosmosErr = 0;
  let indexOk = 0;
  let indexErr = 0;
  for (const c of candidates) {
    try {
      await deletePastAnalysisDoc(c.sessionId, c.id);
      cosmosOk++;
    } catch (err) {
      cosmosErr++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️ cosmos delete failed for ${c.id}: ${msg}`);
    }
    try {
      await deletePastAnalysisById(c.id);
      indexOk++;
    } catch (err) {
      indexErr++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️ ai-search delete failed for ${c.id}: ${msg}`);
    }
  }
  console.log(
    `✅ done · cosmos:${cosmosOk}/${cosmosOk + cosmosErr} · aiSearch:${indexOk}/${indexOk + indexErr}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
