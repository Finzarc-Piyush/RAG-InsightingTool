/**
 * Wave A7 · Automation column-remap LLM call contract.
 *
 * Pin:
 *   - Strict by-name matches are deterministic (no LLM call when 100% match).
 *   - Unmatched columns trigger the LLM with the right purpose.
 *   - LLM-suggested names that aren't in the new dataset are dropped to null
 *     (defence against hallucinated column names).
 *   - LLM-skipped saved columns surface as `unmatchable` (no silent drops).
 *   - LLM failure marks every unmatched column as unmatchable (visible to user).
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { computeAutomationColumnRemap } from "../lib/agents/runtime/automationRemap.js";
import {
  installLlmStub,
  clearLlmStub,
  DEFAULT_STUB_HANDLERS,
} from "./helpers/llmStub.js";
import { LLM_PURPOSE } from "../lib/agents/runtime/llmCallPurpose.js";
import type { AutomationColumnInfo } from "../shared/schema.js";

const cols = (
  ...names: Array<[string, string]>
): AutomationColumnInfo[] =>
  names.map(([name, type]) => ({ name, type, sampleValues: [] }));

describe("Wave A7 · computeAutomationColumnRemap", () => {
  beforeEach(() => {
    installLlmStub({ ...DEFAULT_STUB_HANDLERS });
  });

  afterEach(() => {
    clearLlmStub();
  });

  test("100% by-name match: no LLM call, all exact, no proposals", async () => {
    let llmCalls = 0;
    installLlmStub({
      [LLM_PURPOSE.AUTOMATION_REMAP]: () => {
        llmCalls += 1;
        return { proposedMappings: [] };
      },
    });
    const result = await computeAutomationColumnRemap(
      cols(["Region", "string"], ["Sales", "number"]),
      cols(["Region", "string"], ["Sales", "number"], ["Extra", "number"])
    );
    assert.deepEqual(result.exactMatches.sort(), ["Region", "Sales"]);
    assert.equal(result.proposedMappings.length, 0);
    assert.equal(result.unmatchable.length, 0);
    assert.equal(llmCalls, 0, "should not invoke LLM when all match by name");
  });

  test("case-insensitive by-name match", async () => {
    const result = await computeAutomationColumnRemap(
      cols(["region", "string"]),
      cols(["Region", "string"])
    );
    assert.equal(result.exactMatches.length, 1);
    // The new-dataset's exact name is preserved (with original case).
    assert.equal(result.exactMatches[0], "Region");
  });

  test("unmatched columns trigger the LLM and propagate suggestions", async () => {
    installLlmStub({
      [LLM_PURPOSE.AUTOMATION_REMAP]: () => ({
        proposedMappings: [
          {
            saved: "Sale Value",
            suggested: "Sales",
            confidence: "high",
            reason: "Synonym; samples overlap.",
          },
        ],
      }),
    });
    const result = await computeAutomationColumnRemap(
      cols(["Region", "string"], ["Sale Value", "number"]),
      cols(["Region", "string"], ["Sales", "number"])
    );
    assert.equal(result.exactMatches.length, 1);
    assert.equal(result.proposedMappings.length, 1);
    assert.equal(result.proposedMappings[0].suggested, "Sales");
    assert.equal(result.proposedMappings[0].confidence, "high");
    assert.equal(result.unmatchable.length, 0);
  });

  test("LLM proposes a column NOT in the new dataset → dropped to null + unmatchable", async () => {
    installLlmStub({
      [LLM_PURPOSE.AUTOMATION_REMAP]: () => ({
        proposedMappings: [
          {
            saved: "Sale Value",
            suggested: "TotallyMadeUpColumn", // hallucination
            confidence: "high",
          },
        ],
      }),
    });
    const result = await computeAutomationColumnRemap(
      cols(["Sale Value", "number"]),
      cols(["Sales", "number"])
    );
    assert.equal(result.proposedMappings[0].suggested, null);
    assert.equal(result.proposedMappings[0].confidence, "low");
    assert.ok(result.proposedMappings[0].reason?.includes("LLM suggested"));
    assert.deepEqual(result.unmatchable, ["Sale Value"]);
  });

  test("LLM omits a saved column → that column lands in unmatchable", async () => {
    installLlmStub({
      [LLM_PURPOSE.AUTOMATION_REMAP]: () => ({
        proposedMappings: [], // forgot to address "Sale Value"
      }),
    });
    const result = await computeAutomationColumnRemap(
      cols(["Sale Value", "number"]),
      cols(["Sales", "number"])
    );
    assert.deepEqual(result.unmatchable, ["Sale Value"]);
  });

  test("LLM explicitly returns suggested:null → propagates as unmatchable", async () => {
    installLlmStub({
      [LLM_PURPOSE.AUTOMATION_REMAP]: () => ({
        proposedMappings: [
          {
            saved: "Mystery",
            suggested: null,
            confidence: "low",
            reason: "No plausible match.",
          },
        ],
      }),
    });
    const result = await computeAutomationColumnRemap(
      cols(["Mystery", "string"]),
      cols(["Region", "string"])
    );
    assert.deepEqual(result.unmatchable, ["Mystery"]);
    assert.equal(result.proposedMappings[0].suggested, null);
  });

  test("LLM throws → every unmatched marked as unmatchable", async () => {
    installLlmStub({
      [LLM_PURPOSE.AUTOMATION_REMAP]: () => {
        throw new Error("simulated LLM failure");
      },
    });
    const result = await computeAutomationColumnRemap(
      cols(["A", "string"], ["B", "number"]),
      cols(["X", "string"], ["Y", "number"])
    );
    // No exact matches; no proposals; both unmatchable.
    assert.equal(result.exactMatches.length, 0);
    assert.equal(result.proposedMappings.length, 0);
    assert.deepEqual(result.unmatchable.sort(), ["A", "B"]);
  });
});
