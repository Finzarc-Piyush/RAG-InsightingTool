/**
 * Wave W28 · live-LLM golden replay (env-gated)
 *
 * Runs `runAgentTurn` against the REAL Azure OpenAI / Anthropic provider
 * using a curated set of FMCG questions. Asserts SHAPE of the resulting
 * `AgentLoopResult` — never exact text, since LLM output is non-
 * deterministic. Catches prompt-quality regressions that mock-only tests
 * (W18/W20/W24) cannot: a temperature change that silently shortens
 * answers, a prompt edit that drops `implications`, a domain pack rename
 * that breaks citations, etc.
 *
 * **Double-gated.** Skipped unless BOTH:
 *   - `LIVE_LLM_REPLAY=true`
 *   - `AZURE_OPENAI_API_KEY` is set
 * Default CI never runs this. To run locally:
 *   ```
 *   cd server
 *   LIVE_LLM_REPLAY=true AGENTIC_ALLOW_NO_RAG=true \
 *     AZURE_OPENAI_API_KEY=... AZURE_OPENAI_ENDPOINT=... \
 *     AZURE_OPENAI_DEPLOYMENT_NAME=... \
 *     node --import tsx --test tests/liveLlmGoldenReplayW28.test.ts
 *   ```
 *
 * Cost: ~$0.50–$1.00 per fixture × 3 fixtures = ~$3 per replay run.
 * Time: 10–60s per fixture. Run nightly or pre-release, not per-commit.
 *
 * Assertions are intentionally LOOSE — shape thresholds, not text. Real
 * LLM output drifts; we want a regression net for "the synth path
 * produces a populated envelope with substantive prose," not "exact
 * sentence X appears."
 */
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  ChatDocument,
  DataSummary,
  SessionAnalysisContext,
} from "../shared/schema.js";

const LIVE_ENABLED =
  process.env.LIVE_LLM_REPLAY === "true" &&
  Boolean(process.env.AZURE_OPENAI_API_KEY);

// When the gate is off we still want the file to LOAD without crashing so
// the test runner can report 1 skipped test cleanly. Stub Azure env so the
// transitive openai imports don't reject at module load.
process.env.AZURE_OPENAI_API_KEY ??= "test-skip";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

interface Fixture {
  id: string;
  question: string;
  questionShape: string;
  minBodyChars: number;
  minEnvelopeFields: number;
  expectInvestigationSummary: boolean;
  expectAnswerSourceIn: string[];
}

const FIXTURES_DIR = join(process.cwd(), "tests", "fixtures", "golden-replay");
function loadFixtures(): Fixture[] {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf8")));
}

// Tiny FMCG fixture — same shape as W20's Marico-mini, kept small so the
// real LLM doesn't timeout on planner / narrator passes.
const summary: DataSummary = {
  rowCount: 60,
  columnCount: 6,
  columns: [
    { name: "Brand", type: "string", sampleValues: ["Saffola", "Parachute"] },
    { name: "Region", type: "string", sampleValues: ["South", "East"] },
    { name: "Channel", type: "string", sampleValues: ["MT", "GT", "EC"] },
    { name: "Month", type: "date", sampleValues: ["2024-07"] },
    { name: "Volume_MT", type: "number", sampleValues: [120, 240] },
    { name: "Value_INR", type: "number", sampleValues: [25000, 60000] },
  ],
  numericColumns: ["Volume_MT", "Value_INR"],
  dateColumns: ["Month"],
};

function buildFixtureData(): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  let s = 1;
  for (const b of ["Saffola", "Parachute", "Nihar", "Hair&Care"]) {
    for (const r of ["South", "East", "West", "North"]) {
      for (const c of ["MT", "GT", "EC"]) {
        const m = ["2024-07", "2024-08", "2024-09"][s % 3];
        out.push({
          Brand: b,
          Region: r,
          Channel: c,
          Month: m,
          Volume_MT: 100 + ((s * 7) % 350),
          Value_INR: 25_000 + ((s * 137) % 80_000),
        });
        s++;
      }
    }
  }
  return out.slice(0, 60);
}

const sac: SessionAnalysisContext = {
  version: 1,
  dataset: {
    shortDescription: "Marico monthly brand-region-channel volume tracker.",
    columnRoles: [],
    caveats: [],
  },
  userIntent: { interpretedConstraints: [] },
  sessionKnowledge: { facts: [], analysesDone: [] },
  suggestedFollowUps: [],
  lastUpdated: { reason: "seed", at: new Date().toISOString() },
};

const chatDocument: Partial<ChatDocument> = {
  id: "live-replay",
  sessionId: "live-replay",
  dataSummary: summary,
};

function envelopeFieldCount(env: unknown): number {
  if (!env || typeof env !== "object") return 0;
  const e = env as Record<string, unknown>;
  let n = 0;
  if (e.tldr) n++;
  if (Array.isArray(e.findings) && e.findings.length > 0) n++;
  if (Array.isArray(e.implications) && e.implications.length > 0) n++;
  if (Array.isArray(e.recommendations) && e.recommendations.length > 0) n++;
  if (e.domainLens) n++;
  if (e.methodology) n++;
  return n;
}

describe("W28 · live-LLM golden replay", () => {
  if (!LIVE_ENABLED) {
    it("is skipped (set LIVE_LLM_REPLAY=true and AZURE_OPENAI_API_KEY to enable)", () => {
      // Skipped — recorded as a passing assertion so the test runner
      // reports the file ran. We deliberately don't use `it.skip()` so
      // operators see "this is a real wave that exists; you can opt in."
      assert.equal(LIVE_ENABLED, false);
    });
    return;
  }

  // ── Live path ──
  process.env.AGENTIC_LOOP_ENABLED = "true";
  process.env.AGENTIC_ALLOW_NO_RAG ??= "true";

  // Use a longer test timeout per fixture: real LLM turns can take 10-60s.
  const FIXTURE_TIMEOUT_MS = 90_000;

  for (const fixture of loadFixtures()) {
    it(`fixture: ${fixture.id} — answer + envelope shape`, { timeout: FIXTURE_TIMEOUT_MS }, async () => {
      const { runAgentTurn } = await import(
        "../lib/agents/runtime/agentLoop.service.js"
      );
      const { buildAgentExecutionContext } = await import(
        "../lib/agents/runtime/context.js"
      );
      const { loadAgentConfigFromEnv } = await import(
        "../lib/agents/runtime/types.js"
      );

      const ctx = buildAgentExecutionContext({
        sessionId: "live-replay",
        username: "tester@example.com",
        question: fixture.question,
        data: buildFixtureData(),
        summary,
        chatHistory: [],
        mode: "analysis",
        sessionAnalysisContext: sac,
        chatDocument: chatDocument as ChatDocument,
      });
      // Pre-set the brief to drive the W17 completeness path for analytical
      // fixtures. Live LLM may also produce its own brief; pre-setting just
      // ensures the path is exercised.
      ctx.analysisBrief = {
        questionShape: fixture.questionShape as never,
        outcomeMetricColumn: "Volume_MT",
        segmentationDimensions: ["Brand", "Region", "Channel"],
        candidateDriverDimensions: ["Brand", "Region", "Channel"],
        epistemicNotes: "Observational; avoid causal claims.",
        filters: [],
        requestsDashboard: false,
        clarifyingQuestions: [],
      };

      const config = loadAgentConfigFromEnv();
      const result = await runAgentTurn(ctx, config);

      // ── Loose shape assertions — survives non-determinism ──
      assert.ok(
        result.answer && result.answer.length >= fixture.minBodyChars,
        `${fixture.id}: answer too short (${result.answer?.length ?? 0} < ${fixture.minBodyChars})`
      );
      const fieldCount = envelopeFieldCount(result.answerEnvelope);
      assert.ok(
        fieldCount >= fixture.minEnvelopeFields,
        `${fixture.id}: envelope has ${fieldCount} populated fields (< ${fixture.minEnvelopeFields})`
      );
      if (fixture.expectInvestigationSummary) {
        assert.ok(
          result.investigationSummary,
          `${fixture.id}: investigationSummary missing`
        );
      }
      // Trace presence is a smoke that the loop completed.
      assert.ok(result.agentTrace, `${fixture.id}: agentTrace missing`);
    });
  }
});

after(() => {
  // No teardown needed; live LLM tests don't install stubs.
});
