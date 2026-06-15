import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SSE_EVENT_KIND,
  sseEventSchemas,
  validateSseEvent,
  isKnownSseEventKind,
} from "../shared/sseEvents.js";

/**
 * W6 · SSE event contract.
 *
 * Pins:
 *   1. Every SSE_EVENT_KIND has a matching schema (no missing entries).
 *   2. Every schema is permissive enough to accept the shape the agent loop
 *      currently emits (so adding W6 cannot break shipping turns).
 *   3. Validation is warn-and-pass: unknown kinds pass through; only known
 *      kinds with broken shape return ok:false.
 */

describe("W6 · sseEventSchemas registry", () => {
  it("has a schema for every SSE_EVENT_KIND value", () => {
    for (const kind of Object.values(SSE_EVENT_KIND)) {
      assert.ok(
        sseEventSchemas[kind],
        `Missing schema for kind '${kind}'. Add an entry to server/shared/sseEvents.ts.`
      );
    }
  });

  it("isKnownSseEventKind agrees with the registry", () => {
    for (const kind of Object.values(SSE_EVENT_KIND)) {
      assert.strictEqual(isKnownSseEventKind(kind), true);
    }
    assert.strictEqual(isKnownSseEventKind("unknown_event_xyz"), false);
  });

  // EX15 / API-2 · exhaustiveness: every `safeEmit("kind", ...)` call site in the
  // agent runtime must use a REGISTERED kind. This is the guard that catches a
  // new emit shipping an unregistered event (the gap that left 8 kinds out of
  // the contract). A new unregistered safeEmit now fails CI here.
  it("every safeEmit() kind in the runtime is registered", () => {
    const runtimeDir = fileURLToPath(new URL("../lib/agents/runtime/", import.meta.url));
    const emitRe = /safeEmit\(\s*["']([a-z_]+)["']/g;
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) walk(full);
        else if (name.name.endsWith(".ts")) {
          const src = readFileSync(full, "utf8");
          let m: RegExpExecArray | null;
          while ((m = emitRe.exec(src)) !== null) found.add(m[1]);
        }
      }
    };
    walk(runtimeDir);
    assert.ok(found.size > 0, "expected to find safeEmit call sites");
    const unregistered = [...found].filter((k) => !isKnownSseEventKind(k));
    assert.deepEqual(
      unregistered,
      [],
      `Unregistered SSE kinds emitted via safeEmit: ${unregistered.join(", ")}. ` +
        `Add them to SSE_EVENT_KIND + sseEventSchemas in server/shared/sseEvents.ts.`
    );
  });
});

describe("W6 · validateSseEvent · current emit shapes", () => {
  // Each test case mirrors a real `safeEmit(...)` call site in the agent loop.
  // If we change the emit shape and forget to update the schema, the test will
  // catch the drift before the client does.

  it("tool_call (id + name + args_summary)", () => {
    const v = validateSseEvent(SSE_EVENT_KIND.TOOL_CALL, {
      id: "call_1",
      name: "execute_query_plan",
      args_summary: '{"groupBy":"region"}',
    });
    assert.strictEqual(v.ok, true);
  });

  it("workbench (entry with id + kind)", () => {
    const v = validateSseEvent(SSE_EVENT_KIND.WORKBENCH, {
      entry: {
        id: "wb_1",
        kind: "tool_result",
        title: "execute_query_plan",
        code: "rows: 12,453",
      },
    });
    assert.strictEqual(v.ok, true);
  });

  it("critic_verdict (verdict + issue_codes)", () => {
    const v = validateSseEvent(SSE_EVENT_KIND.CRITIC_VERDICT, {
      stepId: "final",
      verdict: "pass",
      issue_codes: [],
      course_correction: null,
    });
    assert.strictEqual(v.ok, true);
  });

  it("magnitudes (items array of {label, value, confidence?})", () => {
    const v = validateSseEvent(SSE_EVENT_KIND.MAGNITUDES, {
      items: [
        { label: "Q3 sales drop", value: "-12.4%", confidence: "high" },
        { label: "Tier-2 share of gap", value: "78%" },
      ],
    });
    assert.strictEqual(v.ok, true);
  });

  it("unexplained (single string note)", () => {
    const v = validateSseEvent(SSE_EVENT_KIND.UNEXPLAINED, {
      note: "Partial data from two tier-2 stores.",
    });
    assert.strictEqual(v.ok, true);
  });

  it("sub_question_investigated (id + question + chartCount)", () => {
    const v = validateSseEvent(SSE_EVENT_KIND.SUB_QUESTION_INVESTIGATED, {
      id: "sq_1",
      question: "Which TSOE has highest compliance?",
      chartCount: 2,
    });
    assert.strictEqual(v.ok, true);
  });

  it("sub_question_investigated rejects a payload missing `question`", () => {
    const v = validateSseEvent(SSE_EVENT_KIND.SUB_QUESTION_INVESTIGATED, {
      id: "sq_1",
      chartCount: 2,
    });
    assert.strictEqual(v.ok, false);
  });
});

describe("W6 · validateSseEvent · drift detection", () => {
  it("rejects tool_call without an id", () => {
    const v = validateSseEvent(SSE_EVENT_KIND.TOOL_CALL, {
      name: "execute_query_plan",
    });
    assert.strictEqual(v.ok, false);
  });

  it("rejects workbench whose entry lacks `kind`", () => {
    const v = validateSseEvent(SSE_EVENT_KIND.WORKBENCH, {
      entry: { id: "wb_1", title: "missing kind field" },
    });
    assert.strictEqual(v.ok, false);
  });

  it("rejects magnitudes.items with an entry missing `value`", () => {
    const v = validateSseEvent(SSE_EVENT_KIND.MAGNITUDES, {
      items: [{ label: "no value" }],
    });
    assert.strictEqual(v.ok, false);
  });

  it("passes through unknown event kinds (forward-compat by design)", () => {
    const v = validateSseEvent("future_kind_not_yet_registered", { whatever: 1 });
    assert.strictEqual(v.ok, true);
  });
});

describe("W6 · validateSseEvent · passthrough preserves extra fields", () => {
  it("extra fields on tool_call do NOT trigger a validation failure", () => {
    // The schemas use `.passthrough()` so the server can extend payloads
    // (e.g. add provenance metadata) without breaking the contract.
    const v = validateSseEvent(SSE_EVENT_KIND.TOOL_CALL, {
      id: "call_1",
      name: "x",
      args_summary: "{}",
      _newField: "should be ignored",
      _agentTurnId: "turn_42",
    });
    assert.strictEqual(v.ok, true);
  });
});
