/**
 * W-UD-gate cleanup · retire directives that were wrongly mined from plain questions.
 *
 * The W-UD5 LLM directive extractor occasionally saved a plain analytical
 * question ("avg clock in time by cluster") as a standing "persistent rule",
 * which then silently biases future analysis on that dataset. Wave W-UD-gate
 * stops NEW ones at the source (`isQuestionShapedWithoutMarker` in
 * extractUserDirectives.ts); this one-off script retires the ones already
 * persisted in the `dataset_directives` Cosmos container.
 *
 * It reuses the SAME predicate so prevention and cleanup agree, and only touches
 * free-text / preference / definition directives sourced from chat messages —
 * structured exclude/include rules with real column filters and manually-added
 * directives are never touched. It REVOKES (status → "revoked"), not deletes, so
 * the action is auditable and reversible.
 *
 * Usage:
 *   npx tsx server/scripts/purgeQuestionShapedDirectives.ts --dry-run            # preview only
 *   npx tsx server/scripts/purgeQuestionShapedDirectives.ts                      # apply across all users
 *   npx tsx server/scripts/purgeQuestionShapedDirectives.ts --user piyush@finzarc.com
 *
 * Prints a one-line summary at the end suitable for log parsing.
 */

import "../loadEnv.js";
import { waitForDatasetDirectivesContainer } from "../models/database.config.js";
import { revokeDirective } from "../models/datasetDirectives.model.js";
import { isQuestionShapedWithoutMarker } from "../lib/agents/runtime/extractUserDirectives.js";
import type { DatasetDirectivesDoc } from "../shared/schema.js";

/** Only these kinds are candidates — structured exclude/include rules with a
 *  real column filter are left untouched even if their text reads like a question. */
const PURGEABLE_KINDS = new Set<string>(["free-text", "preference", "definition"]);

interface CliArgs {
  dryRun: boolean;
  user?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let dryRun = false;
  let user: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--user" && argv[i + 1]) user = argv[++i];
  }
  return { dryRun, user };
}

interface Candidate {
  username: string;
  fingerprint: string;
  id: string;
  kind: string;
  text: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `🧹 purgeQuestionShapedDirectives: dryRun=${args.dryRun} user=${args.user ?? "*"}`
  );

  const container = await waitForDatasetDirectivesContainer();
  const querySpec = args.user
    ? {
        query: "SELECT * FROM c WHERE c.username = @u",
        parameters: [{ name: "@u", value: args.user.trim().toLowerCase() }],
      }
    : { query: "SELECT * FROM c", parameters: [] as { name: string; value: string }[] };

  let docs: DatasetDirectivesDoc[];
  try {
    const { resources } = await container.items.query(querySpec).fetchAll();
    docs = (resources ?? []) as DatasetDirectivesDoc[];
  } catch (err) {
    console.error(
      `❌ failed to query dataset_directives: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  const candidates: Candidate[] = [];
  for (const doc of docs) {
    for (const d of doc.directives ?? []) {
      if (d.status !== "active") continue;
      if (!PURGEABLE_KINDS.has(d.kind)) continue;
      if (d.source !== "chat-message") continue; // never auto-revoke manual rules
      if (!isQuestionShapedWithoutMarker(d.text)) continue;
      candidates.push({
        username: doc.username,
        fingerprint: doc.datasetFingerprint,
        id: d.id,
        kind: d.kind,
        text: d.text,
      });
    }
  }

  console.log(`🧮 ${candidates.length} question-shaped directive(s) to retire`);
  for (const c of candidates.slice(0, 50)) {
    console.log(
      `   ${args.dryRun ? "would revoke" : "revoke"} [${c.kind}] "${c.text.slice(0, 80)}" ` +
        `(user=${c.username} fp=${c.fingerprint} id=${c.id})`
    );
  }
  if (candidates.length > 50) {
    console.log(`   ... and ${candidates.length - 50} more`);
  }

  if (args.dryRun || candidates.length === 0) {
    console.log(`✅ ${args.dryRun ? "dry-run" : "nothing to do"} · ${candidates.length} candidate(s)`);
    process.exit(0);
  }

  let ok = 0;
  let err = 0;
  for (const c of candidates) {
    try {
      const res = await revokeDirective(c.username, c.fingerprint, c.id);
      if (res) ok++;
    } catch (e) {
      err++;
      console.warn(
        `⚠️ revoke failed for ${c.id}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  console.log(`✅ done · revoked ${ok}/${candidates.length} (${err} error(s))`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
