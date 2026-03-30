import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

describe("agentic routing no legacy fast path", () => {
  it("ensures AGENTIC_LOOP_ENABLED cannot route simple analysis via AgentOrchestrator", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcPath = join(here, "../lib/dataAnalyzer.ts");
    const src = await readFile(srcPath, "utf8");

    assert.doesNotMatch(src, /shouldUseOrchestratorInsteadOfAgentLoop\s*\(/);
    assert.doesNotMatch(src, /Simple analysis fast path/i);
  });
});

