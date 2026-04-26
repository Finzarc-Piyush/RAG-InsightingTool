import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  LLM_PURPOSE,
  envKeyForPurpose,
  rampEnvKeyForPurpose,
  rampPctForPurpose,
  shouldRouteToMini,
  resolveModelFor,
  categoryForPurpose,
} from "../lib/agents/runtime/llmCallPurpose.js";

/**
 * W3.1 · Model routing table is the contract Phase 3 is built on. Every
 * precedence rule here must hold — if a per-purpose override stops winning
 * or a MINI purpose accidentally climbs to PRIMARY, the cost saving evaporates.
 */

const ORIGINAL_ENV = { ...process.env };

function clearOpenaiEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OPENAI_MODEL_") || key === "AZURE_OPENAI_DEPLOYMENT_NAME") {
      delete process.env[key];
    }
  }
}

describe("llmCallPurpose · envKeyForPurpose", () => {
  it("uppercases the purpose token", () => {
    assert.strictEqual(envKeyForPurpose(LLM_PURPOSE.MODE_CLASSIFY), "OPENAI_MODEL_FOR_MODE_CLASSIFY");
    assert.strictEqual(envKeyForPurpose(LLM_PURPOSE.PLANNER), "OPENAI_MODEL_FOR_PLANNER");
    assert.strictEqual(envKeyForPurpose(LLM_PURPOSE.DATAOPS_ML_PARAMS), "OPENAI_MODEL_FOR_DATAOPS_ML_PARAMS");
  });
});

describe("llmCallPurpose · categoryForPurpose", () => {
  it("classifies classification/extraction/repair as MINI", () => {
    for (const p of [
      LLM_PURPOSE.MODE_CLASSIFY,
      LLM_PURPOSE.INTENT_CLASSIFY,
      LLM_PURPOSE.COMPLEX_QUERY_SCORE,
      LLM_PURPOSE.SCHEMA_BIND,
      LLM_PURPOSE.COLUMN_MATCH,
      LLM_PURPOSE.QUERY_PARSE,
      LLM_PURPOSE.TOOL_ARG_REPAIR,
      LLM_PURPOSE.DATE_ENRICH,
      LLM_PURPOSE.TEMPORAL_GRAIN,
      LLM_PURPOSE.DATAOPS_INTENT,
      LLM_PURPOSE.DATAOPS_DEFAULTS,
      LLM_PURPOSE.DATAOPS_ML_PARAMS,
      LLM_PURPOSE.DATAOPS_COMPUTED_COL,
      LLM_PURPOSE.CLARIFY_QUESTION,
      LLM_PURPOSE.SUGGEST_FOLLOW_UPS,
      LLM_PURPOSE.VERIFIER_SIMPLE,
    ]) {
      assert.strictEqual(categoryForPurpose(p), "MINI", `${p} must be MINI`);
    }
  });

  it("classifies reasoning / synthesis as PRIMARY", () => {
    for (const p of [
      LLM_PURPOSE.HYPOTHESIS,
      LLM_PURPOSE.PLANNER,
      LLM_PURPOSE.REFLECTOR,
      LLM_PURPOSE.VERIFIER_DEEP,
      LLM_PURPOSE.NARRATOR,
      LLM_PURPOSE.FINAL_ANSWER,
      LLM_PURPOSE.COORDINATOR,
      LLM_PURPOSE.ANALYSIS_BRIEF,
      LLM_PURPOSE.VISUAL_PLANNER,
      LLM_PURPOSE.BUILD_DASHBOARD,
      LLM_PURPOSE.SQL_GEN,
      LLM_PURPOSE.SESSION_CONTEXT,
      LLM_PURPOSE.DATASET_PROFILE,
      LLM_PURPOSE.INSIGHT_GEN,
      LLM_PURPOSE.CORRELATION_INSIGHT,
      LLM_PURPOSE.CHART_JSON_REPAIR,
      LLM_PURPOSE.CONVERSATIONAL,
      LLM_PURPOSE.ML_MODEL_SUMMARY,
    ]) {
      assert.strictEqual(categoryForPurpose(p), "PRIMARY", `${p} must be PRIMARY`);
    }
  });
});

describe("llmCallPurpose · resolveModelFor", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns OPENAI_MODEL_MINI for MINI purposes when set", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI = "gpt-4o-mini";
    process.env.OPENAI_MODEL_PRIMARY = "gpt-4o";
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.MODE_CLASSIFY), "gpt-4o-mini");
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.SCHEMA_BIND), "gpt-4o-mini");
  });

  it("returns OPENAI_MODEL_PRIMARY for PRIMARY purposes when set", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI = "gpt-4o-mini";
    process.env.OPENAI_MODEL_PRIMARY = "gpt-4o";
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.PLANNER), "gpt-4o");
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.REFLECTOR), "gpt-4o");
  });

  it("per-purpose override beats category default", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI = "gpt-4o-mini";
    process.env.OPENAI_MODEL_PRIMARY = "gpt-4o";
    process.env.OPENAI_MODEL_FOR_MODE_CLASSIFY = "gpt-4o"; // escape hatch — force MINI purpose onto 4o
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.MODE_CLASSIFY), "gpt-4o");
    // sibling MINI purpose still goes to mini
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.SCHEMA_BIND), "gpt-4o-mini");
  });

  it("empty-string per-purpose override is ignored (falls back to category)", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI = "gpt-4o-mini";
    process.env.OPENAI_MODEL_FOR_MODE_CLASSIFY = "   ";
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.MODE_CLASSIFY), "gpt-4o-mini");
  });

  it("whitespace is trimmed from per-purpose override", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_FOR_PLANNER = "  gpt-4o-2024-08-06  ";
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.PLANNER), "gpt-4o-2024-08-06");
  });

  it("falls back to AZURE_OPENAI_DEPLOYMENT_NAME when category env is absent", () => {
    clearOpenaiEnv();
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME = "my-custom-gpt-4o";
    // PRIMARY purpose picks up the deployment name
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.PLANNER), "my-custom-gpt-4o");
    // MINI purpose ALSO picks it up when OPENAI_MODEL_MINI is unset (safer default than dropping to hardcoded)
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.MODE_CLASSIFY), "my-custom-gpt-4o");
  });

  it("hard fallback is 'gpt-4o' for PRIMARY when every env is unset", () => {
    clearOpenaiEnv();
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.PLANNER), "gpt-4o");
  });

  it("hard fallback is 'gpt-4o-mini' for MINI when every env is unset", () => {
    clearOpenaiEnv();
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.MODE_CLASSIFY), "gpt-4o-mini");
  });

  it("MINI category prefers MODEL_PRIMARY over hardcoded mini when MODEL_MINI is unset (conservative)", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_PRIMARY = "gpt-4o";
    // With MINI unset, classification purposes stay on PRIMARY — prevents an
    // unintended quality regression when someone sets MODEL_PRIMARY but
    // forgets MODEL_MINI.
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.MODE_CLASSIFY), "gpt-4o");
  });

  it("precedence order: FOR_<PURPOSE> > MODEL_MINI > MODEL_PRIMARY > AZURE_DEPLOYMENT > hardcoded", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_FOR_MODE_CLASSIFY = "override-A";
    process.env.OPENAI_MODEL_MINI = "mini-B";
    process.env.OPENAI_MODEL_PRIMARY = "primary-C";
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME = "deployment-D";
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.MODE_CLASSIFY), "override-A");

    delete process.env.OPENAI_MODEL_FOR_MODE_CLASSIFY;
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.MODE_CLASSIFY), "mini-B");

    delete process.env.OPENAI_MODEL_MINI;
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.MODE_CLASSIFY), "primary-C");

    delete process.env.OPENAI_MODEL_PRIMARY;
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.MODE_CLASSIFY), "deployment-D");

    delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
    assert.strictEqual(resolveModelFor(LLM_PURPOSE.MODE_CLASSIFY), "gpt-4o-mini");
  });
});

describe("llmCallPurpose · W3.10 rollout ramp", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("rampEnvKeyForPurpose builds the correct env name", () => {
    assert.strictEqual(
      rampEnvKeyForPurpose(LLM_PURPOSE.SCHEMA_BIND),
      "OPENAI_MODEL_MINI_RAMP_SCHEMA_BIND"
    );
  });

  it("rampPctForPurpose returns null when env is absent", () => {
    clearOpenaiEnv();
    assert.strictEqual(rampPctForPurpose(LLM_PURPOSE.SCHEMA_BIND), null);
  });

  it("rampPctForPurpose clamps out-of-range values", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI_RAMP_SCHEMA_BIND = "-20";
    assert.strictEqual(rampPctForPurpose(LLM_PURPOSE.SCHEMA_BIND), 0);
    process.env.OPENAI_MODEL_MINI_RAMP_SCHEMA_BIND = "500";
    assert.strictEqual(rampPctForPurpose(LLM_PURPOSE.SCHEMA_BIND), 100);
  });

  it("rampPctForPurpose ignores non-numeric values", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI_RAMP_SCHEMA_BIND = "not a number";
    assert.strictEqual(rampPctForPurpose(LLM_PURPOSE.SCHEMA_BIND), null);
  });

  it("shouldRouteToMini returns true when ramp env is unset (default = full rollout)", () => {
    clearOpenaiEnv();
    assert.strictEqual(shouldRouteToMini(LLM_PURPOSE.SCHEMA_BIND, "turn_1"), true);
  });

  it("shouldRouteToMini returns true for ramp=100", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI_RAMP_SCHEMA_BIND = "100";
    assert.strictEqual(shouldRouteToMini(LLM_PURPOSE.SCHEMA_BIND, "turn_1"), true);
  });

  it("shouldRouteToMini returns false for ramp=0", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI_RAMP_SCHEMA_BIND = "0";
    assert.strictEqual(shouldRouteToMini(LLM_PURPOSE.SCHEMA_BIND, "turn_1"), false);
  });

  it("shouldRouteToMini is deterministic per (turnId, purpose)", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI_RAMP_SCHEMA_BIND = "50";
    const first = shouldRouteToMini(LLM_PURPOSE.SCHEMA_BIND, "turn_determ_x");
    const second = shouldRouteToMini(LLM_PURPOSE.SCHEMA_BIND, "turn_determ_x");
    const third = shouldRouteToMini(LLM_PURPOSE.SCHEMA_BIND, "turn_determ_x");
    assert.strictEqual(first, second);
    assert.strictEqual(second, third);
  });

  it("shouldRouteToMini at 50% distributes roughly evenly across many turnIds", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI_RAMP_SCHEMA_BIND = "50";
    let trueCount = 0;
    const total = 1000;
    for (let i = 0; i < total; i++) {
      if (shouldRouteToMini(LLM_PURPOSE.SCHEMA_BIND, `turn_${i}`)) trueCount++;
    }
    // Should hover near 50% — allow generous slack (±10%) on 1000 samples.
    assert.ok(
      trueCount > 400 && trueCount < 600,
      `expected ~500 MINI routes out of 1000, got ${trueCount}`
    );
  });

  it("shouldRouteToMini at 25% sends ~1 in 4 to MINI", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI_RAMP_SCHEMA_BIND = "25";
    let trueCount = 0;
    const total = 1000;
    for (let i = 0; i < total; i++) {
      if (shouldRouteToMini(LLM_PURPOSE.SCHEMA_BIND, `turn_${i}`)) trueCount++;
    }
    assert.ok(
      trueCount > 150 && trueCount < 350,
      `expected ~250 MINI routes out of 1000, got ${trueCount}`
    );
  });

  it("shouldRouteToMini with different purposes on the same turnId is not coupled", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI_RAMP_SCHEMA_BIND = "50";
    process.env.OPENAI_MODEL_MINI_RAMP_COLUMN_MATCH = "50";
    // Two purposes on same turn should hash independently — collect the pair
    // across many turnIds and verify we see all 4 outcomes ({T,T}, {T,F}, {F,T}, {F,F}).
    const outcomes = new Set<string>();
    for (let i = 0; i < 200 && outcomes.size < 4; i++) {
      const a = shouldRouteToMini(LLM_PURPOSE.SCHEMA_BIND, `turn_pair_${i}`);
      const b = shouldRouteToMini(LLM_PURPOSE.COLUMN_MATCH, `turn_pair_${i}`);
      outcomes.add(`${a},${b}`);
    }
    assert.strictEqual(outcomes.size, 4, "ramp decisions must be independent per purpose");
  });

  it("resolveModelFor honours the ramp for MINI purposes", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI = "gpt-4o-mini";
    process.env.OPENAI_MODEL_PRIMARY = "gpt-4o";
    process.env.OPENAI_MODEL_MINI_RAMP_SCHEMA_BIND = "0"; // ramp off
    // With ramp=0, every call falls back to PRIMARY even though SCHEMA_BIND is a MINI purpose.
    assert.strictEqual(
      resolveModelFor(LLM_PURPOSE.SCHEMA_BIND, { turnId: "turn_a" }),
      "gpt-4o"
    );
    assert.strictEqual(
      resolveModelFor(LLM_PURPOSE.SCHEMA_BIND, { turnId: "turn_b" }),
      "gpt-4o"
    );
    // Flip to 100 and it returns to MINI.
    process.env.OPENAI_MODEL_MINI_RAMP_SCHEMA_BIND = "100";
    assert.strictEqual(
      resolveModelFor(LLM_PURPOSE.SCHEMA_BIND, { turnId: "turn_a" }),
      "gpt-4o-mini"
    );
  });

  it("ramp does not affect PRIMARY purposes", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI = "gpt-4o-mini";
    process.env.OPENAI_MODEL_PRIMARY = "gpt-4o";
    // Even a ramp env set on a PRIMARY purpose is ignored — it's not category-eligible.
    process.env.OPENAI_MODEL_MINI_RAMP_PLANNER = "50";
    // Collect 100 results — all should be PRIMARY.
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(
        resolveModelFor(LLM_PURPOSE.PLANNER, { turnId: `turn_${i}` }),
        "gpt-4o"
      );
    }
  });

  it("per-purpose override wins over the ramp", () => {
    clearOpenaiEnv();
    process.env.OPENAI_MODEL_MINI = "gpt-4o-mini";
    process.env.OPENAI_MODEL_PRIMARY = "gpt-4o";
    process.env.OPENAI_MODEL_MINI_RAMP_SCHEMA_BIND = "0"; // ramp would force PRIMARY
    process.env.OPENAI_MODEL_FOR_SCHEMA_BIND = "override-model"; // but override wins
    assert.strictEqual(
      resolveModelFor(LLM_PURPOSE.SCHEMA_BIND, { turnId: "turn_a" }),
      "override-model"
    );
  });
});
