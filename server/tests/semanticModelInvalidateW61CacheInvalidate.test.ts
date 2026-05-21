/**
 * Wave W61-cache-invalidate · pure-function tests for the
 * version-bump observability hook + invalidator registry.
 *
 * Pairs with `adminSemanticModelInvalidateW61CacheInvalidate.test.ts`
 * which exercises the four controller mutation paths (patch / revert /
 * delete / add) — this file pins the module-level contract
 * (counter shape, registry semantics, listener-throw isolation,
 * log-token shape, unsubscribe correctness).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  onSemanticModelVersionBumped,
  registerInvalidator,
  __getInvalidationCountForTesting,
  __resetInvalidationCountForTesting,
  __getRegisteredInvalidatorCountForTesting,
  __clearInvalidatorsForTesting,
  type SemanticModelInvalidationEvent,
  type SemanticModelInvalidator,
} from "../lib/semantic/semanticModelInvalidate.js";

function withCapturedConsole<T>(fn: () => T): {
  result: T;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    const result = fn();
    return { result, logs, errors };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

function resetModuleState(): void {
  __resetInvalidationCountForTesting();
  __clearInvalidatorsForTesting();
}

test("W61-cache-invalidate · onSemanticModelVersionBumped increments the testing counter exactly once per call", () => {
  resetModuleState();
  assert.equal(__getInvalidationCountForTesting(), 0);
  withCapturedConsole(() =>
    onSemanticModelVersionBumped({
      sessionId: "sess-1",
      priorVersion: 3,
      nextVersion: 4,
    }),
  );
  assert.equal(__getInvalidationCountForTesting(), 1);
  withCapturedConsole(() =>
    onSemanticModelVersionBumped({
      sessionId: "sess-1",
      priorVersion: 4,
      nextVersion: 5,
    }),
  );
  assert.equal(__getInvalidationCountForTesting(), 2);
});

test("W61-cache-invalidate · onSemanticModelVersionBumped emits the single grep-able log token with sessionId / priorVersion / nextVersion", () => {
  resetModuleState();
  const { logs } = withCapturedConsole(() =>
    onSemanticModelVersionBumped({
      sessionId: "sess-abc",
      priorVersion: 7,
      nextVersion: 8,
    }),
  );
  assert.equal(logs.length, 1);
  const token = logs[0];
  // Single grep-able prefix — ops greps "[semantic-model-invalidate]".
  assert.ok(
    token.startsWith("[semantic-model-invalidate] "),
    `expected log to start with grep prefix, got: ${token}`,
  );
  assert.match(token, /sessionId=sess-abc\b/);
  assert.match(token, /priorVersion=7\b/);
  assert.match(token, /nextVersion=8\b/);
});

test("W61-cache-invalidate · __resetInvalidationCountForTesting zeroes the counter", () => {
  resetModuleState();
  withCapturedConsole(() =>
    onSemanticModelVersionBumped({
      sessionId: "sess-1",
      priorVersion: 1,
      nextVersion: 2,
    }),
  );
  assert.equal(__getInvalidationCountForTesting(), 1);
  __resetInvalidationCountForTesting();
  assert.equal(__getInvalidationCountForTesting(), 0);
});

test("W61-cache-invalidate · onSemanticModelVersionBumped fires no listeners when registry is empty (no exception)", () => {
  resetModuleState();
  assert.equal(__getRegisteredInvalidatorCountForTesting(), 0);
  // Must not throw; must still log + bump counter.
  const { logs, errors } = withCapturedConsole(() =>
    onSemanticModelVersionBumped({
      sessionId: "sess-1",
      priorVersion: 1,
      nextVersion: 2,
    }),
  );
  assert.equal(logs.length, 1);
  assert.equal(errors.length, 0);
  assert.equal(__getInvalidationCountForTesting(), 1);
});

test("W61-cache-invalidate · registerInvalidator fires the listener with the exact event shape", () => {
  resetModuleState();
  const received: SemanticModelInvalidationEvent[] = [];
  const unregister = registerInvalidator((e) => received.push(e));
  try {
    withCapturedConsole(() =>
      onSemanticModelVersionBumped({
        sessionId: "sess-1",
        priorVersion: 9,
        nextVersion: 10,
      }),
    );
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], {
      sessionId: "sess-1",
      priorVersion: 9,
      nextVersion: 10,
    });
  } finally {
    unregister();
  }
});

test("W61-cache-invalidate · registerInvalidator returns an unsubscribe fn that removes the listener", () => {
  resetModuleState();
  let calls = 0;
  const unregister = registerInvalidator(() => {
    calls += 1;
  });
  withCapturedConsole(() =>
    onSemanticModelVersionBumped({
      sessionId: "sess-1",
      priorVersion: 1,
      nextVersion: 2,
    }),
  );
  assert.equal(calls, 1);
  unregister();
  // After unregister, the listener must not fire.
  withCapturedConsole(() =>
    onSemanticModelVersionBumped({
      sessionId: "sess-1",
      priorVersion: 2,
      nextVersion: 3,
    }),
  );
  assert.equal(calls, 1);
});

test("W61-cache-invalidate · unsubscribing one listener leaves siblings registered (no whole-registry teardown)", () => {
  resetModuleState();
  let aCalls = 0;
  let bCalls = 0;
  const unregisterA = registerInvalidator(() => {
    aCalls += 1;
  });
  const unregisterB = registerInvalidator(() => {
    bCalls += 1;
  });
  try {
    unregisterA();
    withCapturedConsole(() =>
      onSemanticModelVersionBumped({
        sessionId: "sess-1",
        priorVersion: 1,
        nextVersion: 2,
      }),
    );
    assert.equal(aCalls, 0, "A was unregistered — must not fire");
    assert.equal(bCalls, 1, "B was still registered — must fire");
  } finally {
    unregisterB();
  }
});

test("W61-cache-invalidate · multiple listeners fire in registration order", () => {
  resetModuleState();
  const sequence: string[] = [];
  const unregisterA = registerInvalidator(() => sequence.push("A"));
  const unregisterB = registerInvalidator(() => sequence.push("B"));
  const unregisterC = registerInvalidator(() => sequence.push("C"));
  try {
    withCapturedConsole(() =>
      onSemanticModelVersionBumped({
        sessionId: "sess-1",
        priorVersion: 1,
        nextVersion: 2,
      }),
    );
    assert.deepEqual(sequence, ["A", "B", "C"]);
  } finally {
    unregisterA();
    unregisterB();
    unregisterC();
  }
});

test("W61-cache-invalidate · a listener that throws does NOT break subsequent listeners (isolation)", () => {
  resetModuleState();
  let postThrowFired = false;
  const unregisterA = registerInvalidator(() => {
    throw new Error("boom-from-listener-A");
  });
  const unregisterB = registerInvalidator(() => {
    postThrowFired = true;
  });
  try {
    const { errors } = withCapturedConsole(() =>
      onSemanticModelVersionBumped({
        sessionId: "sess-1",
        priorVersion: 1,
        nextVersion: 2,
      }),
    );
    assert.ok(postThrowFired, "listener B must fire even after A threw");
    // The thrown error must be logged via console.error, not silently
    // swallowed.
    assert.ok(
      errors.some((e) => e.includes("invalidator threw")),
      "expected console.error log mentioning invalidator throw",
    );
  } finally {
    unregisterA();
    unregisterB();
  }
});

test("W61-cache-invalidate · a listener that throws does NOT propagate to the caller", () => {
  resetModuleState();
  const unregister = registerInvalidator(() => {
    throw new Error("boom-must-not-propagate");
  });
  try {
    // Must NOT throw.
    assert.doesNotThrow(() => {
      withCapturedConsole(() =>
        onSemanticModelVersionBumped({
          sessionId: "sess-1",
          priorVersion: 1,
          nextVersion: 2,
        }),
      );
    });
    // Counter still increments — the hook's contract is "side-effect
    // succeeded from the caller's POV".
    assert.equal(__getInvalidationCountForTesting(), 1);
  } finally {
    unregister();
  }
});

test("W61-cache-invalidate · __getRegisteredInvalidatorCountForTesting reflects register / unregister state", () => {
  resetModuleState();
  assert.equal(__getRegisteredInvalidatorCountForTesting(), 0);
  const unregisterA = registerInvalidator(() => {});
  assert.equal(__getRegisteredInvalidatorCountForTesting(), 1);
  const unregisterB = registerInvalidator(() => {});
  assert.equal(__getRegisteredInvalidatorCountForTesting(), 2);
  unregisterA();
  assert.equal(__getRegisteredInvalidatorCountForTesting(), 1);
  unregisterB();
  assert.equal(__getRegisteredInvalidatorCountForTesting(), 0);
});

test("W61-cache-invalidate · __clearInvalidatorsForTesting drops every registered listener", () => {
  resetModuleState();
  registerInvalidator(() => {});
  registerInvalidator(() => {});
  registerInvalidator(() => {});
  assert.equal(__getRegisteredInvalidatorCountForTesting(), 3);
  __clearInvalidatorsForTesting();
  assert.equal(__getRegisteredInvalidatorCountForTesting(), 0);
});

test("W61-cache-invalidate · unregister is idempotent (calling twice is a no-op on the second call)", () => {
  resetModuleState();
  const unregister = registerInvalidator(() => {});
  assert.equal(__getRegisteredInvalidatorCountForTesting(), 1);
  unregister();
  assert.equal(__getRegisteredInvalidatorCountForTesting(), 0);
  // Second call must not throw and must not double-remove anything.
  assert.doesNotThrow(() => unregister());
  assert.equal(__getRegisteredInvalidatorCountForTesting(), 0);
});

test("W61-cache-invalidate · log token does NOT mention the listener payload (only sessionId / priorVersion / nextVersion)", () => {
  // Load-bearing privacy check: the hook is fired with three primitive
  // fields. The log token must contain ONLY those three fields plus
  // the prefix. A future widening that adds a `model: SemanticModel`
  // payload to the event MUST NOT spill the model into stdout —
  // models can contain user-authored business terms.
  resetModuleState();
  const { logs } = withCapturedConsole(() =>
    onSemanticModelVersionBumped({
      sessionId: "sess-leak-canary",
      priorVersion: 42,
      nextVersion: 43,
    }),
  );
  assert.equal(logs.length, 1);
  const token = logs[0];
  // Strict shape: prefix + the three documented fields.
  assert.equal(
    token,
    "[semantic-model-invalidate] sessionId=sess-leak-canary priorVersion=42 nextVersion=43",
  );
});

test("W61-cache-invalidate · counter survives across listener registrations + unregistrations (decoupled state)", () => {
  resetModuleState();
  // Fire once with no listeners.
  withCapturedConsole(() =>
    onSemanticModelVersionBumped({
      sessionId: "sess-1",
      priorVersion: 1,
      nextVersion: 2,
    }),
  );
  assert.equal(__getInvalidationCountForTesting(), 1);
  // Register, fire, unregister, fire again — counter accumulates.
  const unregister = registerInvalidator(() => {});
  withCapturedConsole(() =>
    onSemanticModelVersionBumped({
      sessionId: "sess-1",
      priorVersion: 2,
      nextVersion: 3,
    }),
  );
  unregister();
  withCapturedConsole(() =>
    onSemanticModelVersionBumped({
      sessionId: "sess-1",
      priorVersion: 3,
      nextVersion: 4,
    }),
  );
  assert.equal(__getInvalidationCountForTesting(), 3);
});

test("W61-cache-invalidate · SemanticModelInvalidator type accepts a sync fn (no Promise return is required)", () => {
  // Compile-time check posing as a runtime assertion: if the type
  // were widened to require Promise<void>, the inline fn below would
  // not satisfy it. Use a named cast so the type is exercised.
  resetModuleState();
  const sync: SemanticModelInvalidator = (e) => {
    void e;
  };
  const unregister = registerInvalidator(sync);
  try {
    withCapturedConsole(() =>
      onSemanticModelVersionBumped({
        sessionId: "sess-1",
        priorVersion: 1,
        nextVersion: 2,
      }),
    );
    assert.equal(__getInvalidationCountForTesting(), 1);
  } finally {
    unregister();
  }
});
