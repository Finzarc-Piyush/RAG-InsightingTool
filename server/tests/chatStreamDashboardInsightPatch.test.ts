import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Wave I3 wiring guard (realigned in Wave Dup7). The dashboard insight patch was
 * copy-pasted inline in both the streaming and non-streaming chat handlers; it is
 * now the shared helper `lib/applyDashboardChartInsights.ts ·
 * applyEnrichedChartsToDashboard`, called by both paths AFTER chart enrichment.
 * The behavioural contract (copy insights by signature, patch by id) is covered
 * by applyChartInsightsBySignature.test.ts + patchDashboardChartInsights.test.ts.
 * This test pins that (a) BOTH chat paths still invoke the patch helper AFTER
 * enrichCharts, and (b) the helper still wires the by-signature copy + by-id
 * patch against the auto-created dashboard id — so a future refactor can't
 * silently drop or reorder it (which would revert dashboards to bare,
 * insight-less charts).
 */

async function readSrc(relFromTests: string): Promise<string> {
  const url = new URL(relFromTests, import.meta.url);
  return readFile(fileURLToPath(url), "utf8");
}

function assertPatchHelperCalledAfterEnrichment(src: string, file: string) {
  const enrichIdx = src.indexOf("enrichCharts(");
  assert.ok(enrichIdx >= 0, `${file}: expected an enrichCharts call`);
  // The helper is imported near the top of the file, so look for an occurrence
  // (the call) at or after the enrichCharts call — not the import.
  const callIdx = src.indexOf("applyEnrichedChartsToDashboard", enrichIdx);
  assert.ok(
    callIdx > enrichIdx,
    `${file}: must call applyEnrichedChartsToDashboard AFTER enrichCharts`,
  );
}

describe("Wave I3 · dashboard chart-insight patch wiring", () => {
  it("streaming path patches insights after enrichCharts", async () => {
    const src = await readSrc("../services/chat/chatStream.service.ts");
    assertPatchHelperCalledAfterEnrichment(src, "chatStream.service.ts");
  });

  it("non-streaming path patches insights after enrichCharts", async () => {
    const src = await readSrc("../services/chat/chat.service.ts");
    assertPatchHelperCalledAfterEnrichment(src, "chat.service.ts");
  });

  it("the shared helper wires by-signature copy + by-id patch", async () => {
    const src = await readSrc("../lib/applyDashboardChartInsights.ts");
    assert.ok(
      src.includes("applyChartInsightsBySignature"),
      "helper: expected applyChartInsightsBySignature usage",
    );
    assert.ok(
      src.includes("patchDashboardChartInsights"),
      "helper: expected patchDashboardChartInsights usage",
    );
    assert.ok(
      src.includes("createdDashboardId"),
      "helper: patch must target the auto-created dashboard id",
    );
  });
});
