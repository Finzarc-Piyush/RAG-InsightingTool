import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBlackboard,
  addHypothesis,
  resolveHypothesis,
  addFinding,
} from "../lib/agents/runtime/analyticalBlackboard.js";
import { buildInvestigationSummary } from "../lib/agents/runtime/buildInvestigationSummary.js";

/**
 * W-CW1 · The investigation summary must stop surfacing never-tested (OPEN)
 * hypotheses — that is the "4 OPEN hypotheses that add nothing" clutter the
 * user complained about. An OPEN-only blackboard (the shape produced for a
 * plain lookup that brainstormed hypotheses but tested none) must collapse to
 * `undefined`; mixed blackboards must keep only the tested ones.
 */
describe("W-CW1 · investigation summary hides OPEN hypotheses", () => {
  it("returns undefined when every hypothesis is OPEN and nothing else is present", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "Survival differs across Pclass because of lifeboat access");
    addHypothesis(bb, "Pclass survival differences are explained by Sex mix");
    addHypothesis(bb, "Pclass survival is partly driven by Fare");
    addHypothesis(bb, "Pclass survival varies with Embarked");

    assert.equal(buildInvestigationSummary(bb), undefined);
  });

  it("keeps only the tested hypotheses when OPEN and tested are mixed", () => {
    const bb = createBlackboard();
    const confirmed = addHypothesis(bb, "Sex mix explains part of the Pclass gap");
    addHypothesis(bb, "Untested: Fare drives the gap");
    addHypothesis(bb, "Untested: Embarked drives the gap");
    resolveHypothesis(bb, confirmed.id, "confirmed", "tool:execute_query_plan:1");

    const out = buildInvestigationSummary(bb);
    assert.ok(out, "summary present when a tested hypothesis exists");
    assert.equal(out.hypotheses?.length, 1);
    assert.equal(out.hypotheses?.[0].status, "confirmed");
    assert.match(out.hypotheses![0].text, /Sex mix/);
  });

  it("still surfaces findings even when all hypotheses are OPEN", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "An untested idea");
    addFinding(bb, {
      sourceRef: "tool:1",
      label: "1st-class survival 62.96% vs 3rd-class 24.24%",
      significance: "notable",
    });

    const out = buildInvestigationSummary(bb);
    assert.ok(out, "findings keep the summary alive");
    assert.equal(out.hypotheses, undefined, "no OPEN hypotheses leak through");
    assert.equal(out.findings?.length, 1);
  });
});
