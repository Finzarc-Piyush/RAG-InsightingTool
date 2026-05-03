#!/usr/bin/env -S node --import tsx
/**
 * W63 · Backfill the Analysis Memory journal from existing chat documents.
 *
 * For every chat doc the script can read:
 *   - one `analysis_created` entry from the upload metadata,
 *   - one `enrichment_complete` entry when datasetProfile is present,
 *   - per assistant turn (a user→assistant message pair):
 *       question_asked, hypothesis(es), finding(s), chart_created(s),
 *       filter_applied(s), conclusion — produced by the same pure mapper
 *       (`buildTurnEndMemoryEntries`) the live producer uses.
 *
 * Safe to re-run: every entry has a deterministic id, so Cosmos upserts
 * collapse duplicates. Skips sessions that already have ≥ N memory entries
 * unless `--force` is passed.
 *
 * Usage:
 *   npx tsx server/scripts/backfill-analysis-memory.ts                # all sessions for the configured user list
 *   npx tsx server/scripts/backfill-analysis-memory.ts --session sid  # single session
 *   npx tsx server/scripts/backfill-analysis-memory.ts --force        # re-emit even when entries already exist
 */
import "../loadEnv.js";
import {
  appendMemoryEntries,
  countMemoryEntries,
} from "../models/analysisMemory.model.js";
import {
  buildTurnEndMemoryEntries,
} from "../lib/agents/runtime/memoryEntryBuilders.js";
import {
  buildAnalysisCreatedEntry,
  buildEnrichmentCompleteEntry,
} from "../lib/agents/runtime/memoryLifecycleBuilders.js";
import { indexMemoryEntries } from "../lib/rag/indexSession.js";
import { isRagEnabled } from "../lib/rag/config.js";
import { getCosmosClient } from "../models/database.config.js";
import type { ChatDocument } from "../models/chat.model.js";
import { initializeCosmosDB } from "../models/index.js";

interface CliArgs {
  sessionId?: string;
  force: boolean;
  limit: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { force: false, limit: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session" || a === "--sessionId") {
      args.sessionId = argv[++i];
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "--limit") {
      args.limit = Number(argv[++i] || args.limit);
    }
  }
  return args;
}

async function fetchChatDocuments(
  sessionId?: string,
  limit = 5000
): Promise<ChatDocument[]> {
  const dbId = process.env.COSMOS_DATABASE_ID || "marico-insights";
  const containerId = process.env.COSMOS_CONTAINER_ID || "chats";
  const client = getCosmosClient();
  const container = client.database(dbId).container(containerId);
  const query = sessionId
    ? {
        query: "SELECT * FROM c WHERE c.sessionId = @sid",
        parameters: [{ name: "@sid", value: sessionId }],
      }
    : { query: `SELECT TOP ${limit} * FROM c ORDER BY c._ts DESC` };
  const { resources } = await container.items
    .query<ChatDocument>(query)
    .fetchAll();
  return resources;
}

async function backfillOne(
  doc: ChatDocument,
  force: boolean
): Promise<{ session: string; added: number; skipped: boolean }> {
  if (!doc.sessionId) return { session: doc.id, added: 0, skipped: true };
  if (!force) {
    const existing = await countMemoryEntries(doc.sessionId);
    if (existing >= 3) {
      return { session: doc.sessionId, added: 0, skipped: true };
    }
  }
  const entries = [];

  // Lifecycle: upload + enrichment.
  entries.push(
    buildAnalysisCreatedEntry({
      sessionId: doc.sessionId,
      username: doc.username,
      fileName: doc.fileName,
      fileSize: doc.analysisMetadata?.fileSize ?? 0,
      createdAt: doc.uploadedAt ?? doc.createdAt ?? Date.now(),
    })
  );
  if (doc.datasetProfile && doc.dataSummary) {
    entries.push(
      buildEnrichmentCompleteEntry({
        sessionId: doc.sessionId,
        username: doc.username,
        rowCount: doc.dataSummary.rowCount ?? 0,
        columnCount: doc.dataSummary.columnCount ?? 0,
        suggestedQuestions:
          doc.sessionAnalysisContext?.suggestedFollowUps ?? [],
        createdAt: doc.lastUpdatedAt ?? doc.createdAt ?? Date.now(),
      })
    );
  }

  // Per-turn batch — pair every assistant message back with the preceding user
  // message. Synthetic turnId so the deterministic id format collides with
  // future re-runs of the same backfill.
  const messages = doc.messages ?? [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    let userMsg = null;
    for (let j = i - 1; j >= 0; j--) {
      if (messages[j].role === "user") {
        userMsg = messages[j];
        break;
      }
    }
    if (!userMsg) continue;
    const turnId = `backfill_${i}_${m.timestamp ?? i}`;
    const turnEntries = buildTurnEndMemoryEntries({
      sessionId: doc.sessionId,
      username: doc.username,
      turnId,
      dataVersion: doc.currentDataBlob?.version ?? 1,
      createdAt: m.timestamp ?? Date.now(),
      question: userMsg.content,
      assistant: m,
      investigationSummary: m.investigationSummary,
      appliedFilters: m.appliedFilters,
    });
    entries.push(...turnEntries);
  }

  if (entries.length > 0) {
    await appendMemoryEntries(entries);
    // W67 · Mirror to AI Search synchronously here (vs the live producer's
    // fire-and-forget path) so a single backfill run leaves the session fully
    // searchable when it returns. Skipped silently when RAG isn't configured.
    if (isRagEnabled()) {
      try {
        await indexMemoryEntries(entries);
      } catch (err) {
        console.warn(
          `  ⚠️ ${doc.sessionId} indexed to Cosmos but AI Search index failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }
  return { session: doc.sessionId, added: entries.length, skipped: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await initializeCosmosDB();

  const docs = await fetchChatDocuments(args.sessionId, args.limit);
  console.log(`📓 Backfill candidates: ${docs.length}`);

  let totalAdded = 0;
  let skipped = 0;
  for (const d of docs) {
    try {
      const r = await backfillOne(d, args.force);
      if (r.skipped) {
        skipped++;
        continue;
      }
      totalAdded += r.added;
      console.log(`  ✓ ${r.session} → +${r.added} entries`);
    } catch (err) {
      console.warn(
        `  ✗ ${d.sessionId ?? d.id} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  console.log(
    `\n✅ Backfill complete · ${totalAdded} entries written · ${skipped} sessions skipped (already populated; use --force to override)`
  );
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
