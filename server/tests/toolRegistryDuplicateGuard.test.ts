import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  ToolRegistry,
  ToolAlreadyRegisteredError,
} from "../lib/agents/runtime/toolRegistry.js";

const noop = async (): Promise<
  import("../lib/agents/runtime/toolRegistry.js").ToolResult
> => ({ ok: true, summary: "" });

describe("ToolRegistry duplicate guard", () => {
  it("throws ToolAlreadyRegisteredError when the same name is registered twice", () => {
    const registry = new ToolRegistry();
    registry.register(
      "run_query_plan",
      z.object({}).strict(),
      noop,
      { description: "first", argsHelp: "{}" }
    );

    assert.throws(
      () =>
        registry.register(
          "run_query_plan",
          z.object({}).strict(),
          noop,
          { description: "second", argsHelp: "{}" }
        ),
      (err: unknown) =>
        err instanceof ToolAlreadyRegisteredError &&
        err.toolName === "run_query_plan"
    );
  });

  it("error message names the colliding tool so grep-triage is fast", () => {
    const registry = new ToolRegistry();
    registry.register(
      "build_chart",
      z.object({}).strict(),
      noop,
      { description: "first", argsHelp: "{}" }
    );

    try {
      registry.register(
        "build_chart",
        z.object({}).strict(),
        noop,
        { description: "second", argsHelp: "{}" }
      );
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof ToolAlreadyRegisteredError);
      assert.match((err as Error).message, /build_chart/);
      assert.match((err as Error).message, /already registered/);
    }
  });

  it("still allows distinct names to register normally", () => {
    const registry = new ToolRegistry();
    registry.register(
      "run_a",
      z.object({}).strict(),
      noop,
      { description: "A", argsHelp: "{}" }
    );
    registry.register(
      "run_b",
      z.object({}).strict(),
      noop,
      { description: "B", argsHelp: "{}" }
    );
    assert.equal(
      registry.listToolDescriptions().split(", ").length,
      2
    );
  });
});
