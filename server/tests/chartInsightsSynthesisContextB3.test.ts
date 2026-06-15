import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Wave B3 · Pins that every LIVE caller of `generateChartInsights`
 * passes a populated `synthesisContext` (or has a documented reason
 * not to). The audit identified that `synthesisContext` was a declared
 * parameter that was rarely populated; PVT1 wired the chart-key-insight
 * endpoint, but other callers needed verification.
 *
 * Audit results (verified by source inspection):
 *   - LIVE callers — MUST pass synthesisContext:
 *     * services/chat/chatStream.service.ts (the agent-turn enrichCharts
 *       path) — passes userQuestion + sessionAnalysisContext +
 *       permanentContext + domainContext.
 *     * services/chat/chat.service.ts (non-streaming sibling) — same.
 *     * controllers/sessionController.ts (chart-key-insight endpoint
 *       wired in PVT1) — same.
 *     * lib/correlationAnalyzer.ts (W12) — passes synthesisContext.
 *
 *   - UPLOAD-TIME callers — synthesisContext NOT applicable:
 *     * lib/dataAnalyzer.ts:183, 324 — runs before the user has
 *       interacted with the dataset; no question / SAC / userIntent
 *       in scope. Passing undefined is correct.
 *
 * (The former DEAD forward-compat caller `analyticalChartSpec.ts:
 * mergeDeterministicAnalyticalCharts` was deleted as confirmed dead code —
 * see docs/decisions/duplication-audit-deferrals.md. Its synthesisContext pin
 * went with it; the four LIVE pins below remain the contract.)
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverRoot = resolve(__dirname, "..");

function readSrc(rel: string): string {
  return readFileSync(resolve(serverRoot, rel), "utf8");
}

describe("Wave B3 · LIVE chart-insight callers pass synthesisContext", () => {
  it("services/chat/chatStream.service.ts.enrichCharts callsite includes userQuestion + sessionAnalysisContext + permanentContext + domainContext", () => {
    const src = readSrc("services/chat/chatStream.service.ts");
    const enrichCallMatch = src.match(
      /enrichCharts\s*\(\s*[\s\S]+?\}\s*\)/
    );
    assert.ok(enrichCallMatch, "could not find enrichCharts call in chatStream.service.ts");
    const block = enrichCallMatch![0];
    assert.match(block, /userQuestion\s*:/, "userQuestion must be threaded");
    assert.match(
      block,
      /sessionAnalysisContext\s*:/,
      "sessionAnalysisContext must be threaded"
    );
    assert.match(
      block,
      /permanentContext\s*[,:]/,
      "permanentContext must be threaded"
    );
    assert.match(
      block,
      /domainContext\s*:/,
      "domainContext must be threaded"
    );
  });

  it("services/chat/chat.service.ts.enrichCharts callsite includes the same four context fields", () => {
    const src = readSrc("services/chat/chat.service.ts");
    const enrichCallMatch = src.match(
      /enrichCharts\s*\(\s*[\s\S]+?\}\s*\)/
    );
    assert.ok(enrichCallMatch, "could not find enrichCharts call in chat.service.ts");
    const block = enrichCallMatch![0];
    assert.match(block, /userQuestion\s*:/);
    assert.match(block, /sessionAnalysisContext\s*:/);
    assert.match(block, /permanentContext\s*[,:]/);
    assert.match(block, /domainContext\s*:/);
  });

  it("controllers/sessionController.ts (chart-key-insight endpoint, PVT1) passes generateChartInsights with full synthesis context", () => {
    const src = readSrc("controllers/sessionController.ts");
    // Find the generateChartInsights call (PVT1 wired this — verify it's still wired).
    const callMatch = src.match(
      /generateChartInsights\s*\(\s*[\s\S]+?\}\s*\)/
    );
    assert.ok(
      callMatch,
      "could not find generateChartInsights call in sessionController.ts"
    );
    const block = callMatch![0];
    // Must reference a synthesisContext-shaped 5th arg with at least
    // userQuestion + sessionAnalysisContext (PVT1 contract).
    assert.match(
      block,
      /userQuestion/,
      "PVT1 contract: userQuestion must be threaded into generateChartInsights"
    );
    assert.match(
      block,
      /sessionAnalysisContext|synthesisContext/,
      "PVT1 contract: sessionAnalysisContext must be threaded"
    );
  });

  it("lib/correlationAnalyzer.ts forwards synthesisContext to generateChartInsights (W12)", () => {
    const src = readSrc("lib/correlationAnalyzer.ts");
    const callMatch = src.match(/generateChartInsights\s*\([^)]+synthesisContext\s*\)/);
    assert.ok(
      callMatch,
      "correlationAnalyzer.ts must pass synthesisContext positionally to generateChartInsights"
    );
  });
});
