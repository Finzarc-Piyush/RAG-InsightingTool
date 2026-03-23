import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ToolRegistry } from "../lib/agents/runtime/toolRegistry.js";

const noop = async (): Promise<import("../lib/agents/runtime/toolRegistry.js").ToolResult> => ({
  ok: true,
  summary: "",
});

describe("tool manifest for planner", () => {
  it("includes analytical vs retrieve arg distinction", () => {
    const registry = new ToolRegistry();
    registry.register(
      "run_analytical_query",
      z.object({ question_override: z.string().optional() }).strict(),
      noop,
      {
        description: "NL analytical query for aggregates.",
        argsHelp:
          '{"question_override"?: string} Never use key "query" — use retrieve_semantic_context for search.',
      }
    );
    registry.register(
      "retrieve_semantic_context",
      z.object({ query: z.string().min(1) }).strict(),
      noop,
      {
        description: "Vector search over indexed chunks.",
        argsHelp: '{"query": string} required.',
      }
    );
    const m = registry.formatToolManifestForPlanner(50_000);
    assert.match(m, /run_analytical_query/i);
    assert.match(m, /retrieve_semantic_context/i);
    assert.match(m, /question_override/);
    assert.match(m, /"query"/);
  });

  it("rejects unknown query key on run_analytical_query", () => {
    const registry = new ToolRegistry();
    registry.register(
      "run_analytical_query",
      z.object({ question_override: z.string().optional() }).strict(),
      noop,
      { description: "x", argsHelp: "{}" }
    );
    assert.ok(!registry.argsValidForTool("run_analytical_query", { query: "x" }));
    assert.ok(registry.argsValidForTool("run_analytical_query", {}));
    assert.ok(
      registry.argsValidForTool("run_analytical_query", {
        question_override: "totals",
      })
    );
  });

  it("requires query on retrieve_semantic_context", () => {
    const registry = new ToolRegistry();
    registry.register(
      "retrieve_semantic_context",
      z.object({ query: z.string().min(1) }).strict(),
      noop,
      { description: "x", argsHelp: "{}" }
    );
    assert.ok(!registry.argsValidForTool("retrieve_semantic_context", {}));
    assert.ok(
      registry.argsValidForTool("retrieve_semantic_context", { query: "themes" })
    );
  });

  it("getArgsHelpForTool returns schema hint", () => {
    const registry = new ToolRegistry();
    registry.register(
      "run_data_ops",
      z.object({ reason: z.string().optional() }).strict(),
      noop,
      { description: "Data ops", argsHelp: '{"reason"?: string}' }
    );
    assert.ok(registry.getArgsHelpForTool("run_data_ops")?.includes("reason"));
  });
});
