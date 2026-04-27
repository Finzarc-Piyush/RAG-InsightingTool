import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * W2 invariants for the final-answer synthesizer:
 *
 *  1. The envelope schema requires `body.min(1)` so the LLM cannot return an
 *     empty body and have it cascade silently to the deterministic dump.
 *  2. The retry chain is JSON envelope → narrative_retry → plain_text_retry →
 *     fallback_dump, each tagged via `source` so downstream waves know what
 *     produced the answer.
 *  3. The narrative-retry helper hard-rejects responses that begin with
 *     "Summary from" so the model cannot parrot the deterministic prefix.
 */

describe("synthesizer body.min(1) schema (Wave W2)", () => {
  it("rejects an envelope with empty body", () => {
    // Mirror the schema shape inline so this test is decoupled from imports
    // that pull in the full agentLoop module (which itself imports OpenAI).
    const magnitudeSchema = z.object({
      label: z.string().min(1).max(140),
      value: z.string().min(1).max(80),
      confidence: z.enum(["low", "medium", "high"]).optional(),
    });
    const finalAnswerEnvelopeSchema = z.object({
      body: z.string().min(1),
      keyInsight: z.string().nullable().optional(),
      ctas: z.array(z.string()).max(3),
      magnitudes: z.array(magnitudeSchema).max(6).optional(),
      unexplained: z.string().max(800).optional(),
    });

    const empty = finalAnswerEnvelopeSchema.safeParse({
      body: "",
      ctas: ["Investigate product category performance by region"],
      magnitudes: [{ label: "West", value: "$710K" }],
    });
    assert.equal(empty.success, false, "empty body must be rejected");

    const ok = finalAnswerEnvelopeSchema.safeParse({
      body: "The total sales by region are: West $710K, East $670K…",
      ctas: [],
    });
    assert.equal(ok.success, true, "non-empty body must validate");
  });
});

describe("synthesizer retry chain (Wave W2)", () => {
  let src = "";
  it("loads agentLoop source", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcPath = join(here, "../lib/agents/runtime/agentLoop.service.ts");
    src = await readFile(srcPath, "utf8");
    assert.ok(src.length > 0);
  });

  it("schema uses z.string().min(1) for body", () => {
    assert.match(
      src,
      /finalAnswerEnvelopeSchema\s*=\s*z\.object\(\{[\s\S]*?body:\s*z\.string\(\)\.min\(1\)/,
      "Expected body: z.string().min(1) on the final-answer envelope schema"
    );
  });

  it("declares the SynthesisSource union with all four states", () => {
    for (const variant of [
      `"json_envelope"`,
      `"narrative_retry"`,
      `"plain_text_retry"`,
      `"fallback_dump"`,
    ]) {
      assert.ok(
        src.includes(`type SynthesisSource`) && src.includes(variant),
        `SynthesisSource union must include ${variant}`
      );
    }
  });

  it("defines runNarrativeRetry with the strict prompt", () => {
    assert.match(
      src,
      /async function runNarrativeRetry\(/,
      "Expected runNarrativeRetry helper"
    );
    assert.match(
      src,
      /MUST cite at least two specific numbers/,
      "narrative-retry prompt must demand at least two specific numbers"
    );
    // String literals in TS source are split across lines with `+` — collapse
    // whitespace and quote-plus-newline-plus-quote concatenations before
    // matching the prompt fragment.
    const collapsed = src.replace(/"\s*\+\s*\n\s*"/g, "").replace(/\s+/g, " ");
    assert.match(
      collapsed,
      /Do NOT begin with 'Summary from'/,
      "narrative-retry prompt must forbid the 'Summary from' prefix"
    );
  });

  it("rejects model responses starting with 'Summary from' in both retry helpers", () => {
    // Two separate occurrences — once in runNarrativeRetry, once in runPlainTextRetry.
    const matches = src.match(/\.toLowerCase\(\)\.startsWith\("summary from"\)/g) ?? [];
    assert.ok(
      matches.length >= 2,
      `Expected the 'summary from' guard in both retry helpers, found ${matches.length}`
    );
  });

  it("tags every return path of synthesizeFinalAnswerEnvelope with a SynthesisSource", () => {
    // Each return inside the function must include `source:` so downstream
    // (W3 answerSource tracking, W4 verifier skip) has a reliable signal.
    const funcStart = src.indexOf("async function synthesizeFinalAnswerEnvelope(");
    const funcEnd = src.indexOf("\n}\n", funcStart);
    assert.ok(funcStart > 0 && funcEnd > funcStart, "Could not locate synth fn body");
    const body = src.slice(funcStart, funcEnd);

    const returns = body.match(/return\s*\{/g) ?? [];
    const sourceTags = body.match(/source:\s*"(json_envelope|narrative_retry|plain_text_retry|fallback_dump)"/g) ?? [];
    assert.ok(returns.length >= 4, `Expected at least 4 return statements, got ${returns.length}`);
    assert.equal(
      returns.length,
      sourceTags.length,
      `Every return must carry a source tag: ${returns.length} returns vs ${sourceTags.length} tagged`
    );
  });
});
