import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Wave I3 wiring guard. The dashboard insight patch is inline in two large
 * SSE/handler functions that can't be unit-invoked here; the behavioural
 * contract (copy insights by signature, patch by id) is covered by
 * applyChartInsightsBySignature.test.ts + patchDashboardChartInsights.test.ts.
 * This test pins that BOTH chat paths actually call the patch AFTER chart
 * enrichment, so a future refactor can't silently drop or reorder it (which
 * would revert dashboards to bare, insight-less charts).
 */

async function readSrc(relFromTests: string): Promise<string> {
  const url = new URL(relFromTests, import.meta.url);
  return readFile(fileURLToPath(url), "utf8");
}

function assertWiredAfterEnrichment(src: string, file: string) {
  const enrichIdx = src.indexOf("enrichCharts(");
  const applyIdx = src.indexOf("applyChartInsightsBySignature");
  const patchIdx = src.indexOf("patchDashboardChartInsights");
  assert.ok(enrichIdx >= 0, `${file}: expected an enrichCharts call`);
  assert.ok(applyIdx >= 0, `${file}: expected applyChartInsightsBySignature usage`);
  assert.ok(patchIdx >= 0, `${file}: expected patchDashboardChartInsights usage`);
  assert.ok(
    applyIdx > enrichIdx,
    `${file}: insight patch must run AFTER enrichCharts`,
  );
  assert.ok(
    src.includes("createdDashboardId"),
    `${file}: patch must target the auto-created dashboard id`,
  );
}

describe("Wave I3 · dashboard chart-insight patch wiring", () => {
  it("streaming path patches insights after enrichCharts", async () => {
    const src = await readSrc("../services/chat/chatStream.service.ts");
    assertWiredAfterEnrichment(src, "chatStream.service.ts");
  });

  it("non-streaming path patches insights after enrichCharts", async () => {
    const src = await readSrc("../services/chat/chat.service.ts");
    assertWiredAfterEnrichment(src, "chat.service.ts");
  });
});
