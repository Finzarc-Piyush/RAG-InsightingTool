import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldUseOrchestratorInsteadOfAgentLoop,
  isSimpleAnalysisFastPathEnabled,
} from "../lib/agents/simpleAnalysisFastPath.js";

describe("simpleAnalysisFastPath", () => {
  it("defaults to enabled when env unset", () => {
    const prev = process.env.SIMPLE_ANALYSIS_FAST_PATH;
    delete process.env.SIMPLE_ANALYSIS_FAST_PATH;
    try {
      assert.equal(isSimpleAnalysisFastPathEnabled(), true);
    } finally {
      if (prev !== undefined) process.env.SIMPLE_ANALYSIS_FAST_PATH = prev;
      else delete process.env.SIMPLE_ANALYSIS_FAST_PATH;
    }
  });

  it("respects SIMPLE_ANALYSIS_FAST_PATH=0", () => {
    const prev = process.env.SIMPLE_ANALYSIS_FAST_PATH;
    process.env.SIMPLE_ANALYSIS_FAST_PATH = "0";
    try {
      assert.equal(isSimpleAnalysisFastPathEnabled(), false);
      assert.equal(
        shouldUseOrchestratorInsteadOfAgentLoop("what is my sales trend", "analysis"),
        false
      );
    } finally {
      if (prev !== undefined) process.env.SIMPLE_ANALYSIS_FAST_PATH = prev;
      else delete process.env.SIMPLE_ANALYSIS_FAST_PATH;
    }
  });

  it("routes trend questions in analysis mode", () => {
    assert.equal(
      shouldUseOrchestratorInsteadOfAgentLoop("What is my sales trend over time?", "analysis"),
      true
    );
    assert.equal(
      shouldUseOrchestratorInsteadOfAgentLoop("Show me a line chart of revenue by month", "analysis"),
      true
    );
  });

  it("does not route dataOps or modeling", () => {
    assert.equal(
      shouldUseOrchestratorInsteadOfAgentLoop("show sales trend", "dataOps"),
      false
    );
    assert.equal(
      shouldUseOrchestratorInsteadOfAgentLoop("train a model", "modeling"),
      false
    );
  });

  it("does not route correlation or dashboard", () => {
    assert.equal(
      shouldUseOrchestratorInsteadOfAgentLoop(
        "What is the correlation between A and B?",
        "analysis"
      ),
      false
    );
    assert.equal(
      shouldUseOrchestratorInsteadOfAgentLoop("Build a dashboard of KPIs", "analysis"),
      false
    );
  });

  it("does not route diagnostic driver phrasing to orchestrator fast path", () => {
    assert.equal(
      shouldUseOrchestratorInsteadOfAgentLoop(
        "Investigating factors driving Technology's success in the East.",
        "analysis"
      ),
      false
    );
  });
});
