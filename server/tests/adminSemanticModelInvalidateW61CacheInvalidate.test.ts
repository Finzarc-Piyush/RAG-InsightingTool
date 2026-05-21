/**
 * Wave W61-cache-invalidate · controller integration tests pinning that
 * EVERY model-mutating handler (patch / revert / delete / add) fires the
 * `onSemanticModelVersionBumped` hook exactly once on the success path,
 * with the correct `{ sessionId, priorVersion, nextVersion }` triple,
 * and DOES NOT fire on any error path (admin gate, validation, 404, 409,
 * updater throw).
 *
 * Pairs with `semanticModelInvalidateW61CacheInvalidate.test.ts` which
 * pins the module's pure-function contract; this file pins the
 * controller contract: every mutation path calls the hook AFTER the
 * persist succeeds, inside the `withSessionWriteLock` window, and not
 * before.
 *
 * The tests register a listener via `registerInvalidator()` rather than
 * reading the global counter — the listener captures the event payload
 * so per-test isolation is by-construction (registering + unregistering
 * within a single test) and the assertion can examine the exact event
 * shape, not just the count.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  patchSemanticModel,
  revertSemanticModel,
  deleteSemanticModelEntry,
  addSemanticModelEntry,
  __setSemanticModelDetailFetcherForTesting,
  __setSemanticModelUpdaterForTesting,
} from "../controllers/adminSemanticModelController.js";
import type { ChatDocument } from "../models/chat.model.js";
import type {
  SemanticDimension,
  SemanticMetric,
  SemanticModel,
} from "../shared/schema.js";
import {
  __setSuperadminEmailsForTesting,
  __resetSuperadminEmailsForTesting,
} from "../lib/superadmin.js";
import {
  registerInvalidator,
  __resetInvalidationCountForTesting,
  __clearInvalidatorsForTesting,
  type SemanticModelInvalidationEvent,
} from "../lib/semantic/semanticModelInvalidate.js";

function fakeRes(): Response & { _body?: unknown; _status?: number } {
  const r: any = {};
  r._status = 200;
  r.status = (code: number) => {
    r._status = code;
    return r;
  };
  r.json = (b: unknown) => {
    r._body = b;
    return r;
  };
  return r;
}

function fakeReq(args: {
  email?: string;
  params?: Record<string, string>;
  body?: unknown;
}): Request {
  return {
    headers: args.email ? { "x-user-email": args.email } : {},
    params: args.params ?? {},
    body: args.body ?? {},
    auth: undefined,
  } as unknown as Request;
}

function silenceConsole<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  const origError = console.error;
  console.log = () => {};
  console.error = () => {};
  return fn().finally(() => {
    console.log = origLog;
    console.error = origError;
  });
}

const FIXTURE_SESSION = "sess-cache-invalidate";
const ADMIN_EMAIL = "admin@example.com";

function makeMetric(
  name: string,
  source: SemanticMetric["source"] = "auto",
): SemanticMetric {
  return {
    name,
    label: `${name} label`,
    expression: `SUM(${name}_col)`,
    format: "number",
    references: [`${name}_col`],
    exposed: true,
    source,
  };
}

function makeDimension(
  name: string,
  source: SemanticDimension["source"] = "auto",
): SemanticDimension {
  return {
    name,
    label: `${name} label`,
    column: `${name}_col`,
    kind: "categorical",
    exposed: true,
    source,
  };
}

function makeModel(args: {
  version?: number;
  metrics?: SemanticMetric[];
  dimensions?: SemanticDimension[];
} = {}): SemanticModel {
  return {
    version: args.version ?? 3,
    name: "Sales model",
    metrics: args.metrics ?? [makeMetric("alpha"), makeMetric("beta")],
    dimensions: args.dimensions ?? [],
    hierarchies: [],
  };
}

function makeDoc(model: SemanticModel | undefined): ChatDocument {
  return {
    id: "doc-1",
    username: "alice@example.com",
    sessionId: FIXTURE_SESSION,
    fileName: "sales.csv",
    lastUpdatedAt: 1_700_000_000_000,
    semanticModel: model,
  } as ChatDocument;
}

interface HarnessState {
  events: SemanticModelInvalidationEvent[];
  unregister: () => void;
}

function attachListener(): HarnessState {
  __clearInvalidatorsForTesting();
  __resetInvalidationCountForTesting();
  const events: SemanticModelInvalidationEvent[] = [];
  const unregister = registerInvalidator((e) => events.push(e));
  return { events, unregister };
}

function detach(state: HarnessState): void {
  state.unregister();
  __clearInvalidatorsForTesting();
  __resetInvalidationCountForTesting();
}

// ─── PATCH (W61-save) ────────────────────────────────────────────────

test("W61-cache-invalidate · patchSemanticModel: success path fires hook once with priorVersion → nextVersion", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  const state = attachListener();
  const startingModel = makeModel({ version: 5 });
  let currentDoc: ChatDocument | null = makeDoc(startingModel);
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await silenceConsole(() =>
      patchSemanticModel(
        fakeReq({
          email: ADMIN_EMAIL,
          params: { sessionId: FIXTURE_SESSION },
          body: {
            ...startingModel,
            // The actual patch flips an exposed flag — small valid edit.
            metrics: [{ ...startingModel.metrics[0], exposed: false }, startingModel.metrics[1]],
          },
        }),
        res,
      ),
    );
    assert.equal(res._status, 200, `expected 200, got ${res._status}`);
    assert.equal(state.events.length, 1, "hook fired exactly once");
    assert.deepEqual(state.events[0], {
      sessionId: FIXTURE_SESSION,
      priorVersion: 5,
      nextVersion: 6,
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
    detach(state);
  }
});

test("W61-cache-invalidate · patchSemanticModel: 403 (admin gate) does NOT fire the hook", async () => {
  __resetSuperadminEmailsForTesting();
  process.env.DISABLE_AUTH = "true";
  const state = attachListener();
  try {
    const res = fakeRes();
    await silenceConsole(() =>
      patchSemanticModel(
        fakeReq({
          email: "random@example.com",
          params: { sessionId: FIXTURE_SESSION },
          body: makeModel({ version: 5 }),
        }),
        res,
      ),
    );
    assert.equal(res._status, 403);
    assert.equal(state.events.length, 0, "hook must not fire on 403");
  } finally {
    delete process.env.DISABLE_AUTH;
    detach(state);
  }
});

test("W61-cache-invalidate · patchSemanticModel: 400 (invalid body) does NOT fire the hook", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  const state = attachListener();
  try {
    const res = fakeRes();
    await silenceConsole(() =>
      patchSemanticModel(
        fakeReq({
          email: ADMIN_EMAIL,
          params: { sessionId: FIXTURE_SESSION },
          body: { metrics: "not an array" },
        }),
        res,
      ),
    );
    assert.equal(res._status, 400);
    assert.equal(state.events.length, 0, "hook must not fire on 400");
  } finally {
    __resetSuperadminEmailsForTesting();
    delete process.env.DISABLE_AUTH;
    detach(state);
  }
});

test("W61-cache-invalidate · patchSemanticModel: 404 (session not found) does NOT fire the hook", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => null);
  const state = attachListener();
  try {
    const res = fakeRes();
    await silenceConsole(() =>
      patchSemanticModel(
        fakeReq({
          email: ADMIN_EMAIL,
          params: { sessionId: "ghost" },
          body: makeModel({ version: 5 }),
        }),
        res,
      ),
    );
    assert.equal(res._status, 404);
    assert.equal(state.events.length, 0, "hook must not fire on 404");
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
    detach(state);
  }
});

test("W61-cache-invalidate · patchSemanticModel: 500 (updater throws) does NOT fire the hook (load-bearing: persist failed)", async () => {
  // The hook fires AFTER `await _updater(doc)` succeeds. If the
  // updater throws, the catch block emits 500 and the hook MUST NOT
  // have fired — otherwise a downstream cache would invalidate
  // against a write that never landed.
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => makeDoc(makeModel({ version: 5 })));
  __setSemanticModelUpdaterForTesting(async () => {
    throw new Error("simulated Cosmos outage");
  });
  const state = attachListener();
  try {
    const res = fakeRes();
    await silenceConsole(() =>
      patchSemanticModel(
        fakeReq({
          email: ADMIN_EMAIL,
          params: { sessionId: FIXTURE_SESSION },
          body: makeModel({ version: 5 }),
        }),
        res,
      ),
    );
    assert.equal(res._status, 500);
    assert.equal(
      state.events.length,
      0,
      "hook must NOT fire when persist throws — would invalidate against a non-existent write",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
    detach(state);
  }
});

// ─── REVERT (W61-audit-revert) ───────────────────────────────────────

test("W61-cache-invalidate · revertSemanticModel: success path fires hook once", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  const priorModel = makeModel({ version: 1 });
  const currentModel = makeModel({ version: 2 });
  let currentDoc: ChatDocument | null = {
    ...makeDoc(currentModel),
    semanticModelAuditLog: [
      {
        savedAt: 1_700_000_000_000,
        savedBy: "earlier@example.com",
        priorVersion: 1,
        priorModel,
      },
    ],
  } as ChatDocument;
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  const state = attachListener();
  try {
    const res = fakeRes();
    await silenceConsole(() =>
      revertSemanticModel(
        fakeReq({
          email: ADMIN_EMAIL,
          params: { sessionId: FIXTURE_SESSION },
          body: { auditEntryIndex: 0 },
        }),
        res,
      ),
    );
    assert.equal(res._status, 200, `expected 200, got ${res._status}`);
    assert.equal(state.events.length, 1);
    assert.deepEqual(state.events[0], {
      sessionId: FIXTURE_SESSION,
      priorVersion: 2,
      nextVersion: 3,
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
    detach(state);
  }
});

test("W61-cache-invalidate · revertSemanticModel: 404 (audit_entry_not_found) does NOT fire the hook", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  // Doc has no audit log → out-of-range index → 404, no mutation.
  __setSemanticModelDetailFetcherForTesting(async () => makeDoc(makeModel({ version: 2 })));
  const state = attachListener();
  try {
    const res = fakeRes();
    await silenceConsole(() =>
      revertSemanticModel(
        fakeReq({
          email: ADMIN_EMAIL,
          params: { sessionId: FIXTURE_SESSION },
          body: { auditEntryIndex: 0 },
        }),
        res,
      ),
    );
    assert.equal(res._status, 404);
    assert.equal(state.events.length, 0);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
    detach(state);
  }
});

// ─── DELETE (W61-delete-server) ──────────────────────────────────────

test("W61-cache-invalidate · deleteSemanticModelEntry: success path fires hook once", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc: ChatDocument | null = makeDoc(
    makeModel({
      version: 9,
      metrics: [makeMetric("alpha"), makeMetric("beta")],
    }),
  );
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  const state = attachListener();
  try {
    const res = fakeRes();
    await silenceConsole(() =>
      deleteSemanticModelEntry(
        fakeReq({
          email: ADMIN_EMAIL,
          params: {
            sessionId: FIXTURE_SESSION,
            kind: "metric",
            name: "alpha",
          },
        }),
        res,
      ),
    );
    assert.equal(res._status, 200, `expected 200, got ${res._status}`);
    assert.equal(state.events.length, 1);
    assert.deepEqual(state.events[0], {
      sessionId: FIXTURE_SESSION,
      priorVersion: 9,
      nextVersion: 10,
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
    detach(state);
  }
});

test("W61-cache-invalidate · deleteSemanticModelEntry: 404 (entry_not_found) does NOT fire the hook", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(makeModel({ metrics: [makeMetric("alpha")] })),
  );
  const state = attachListener();
  try {
    const res = fakeRes();
    await silenceConsole(() =>
      deleteSemanticModelEntry(
        fakeReq({
          email: ADMIN_EMAIL,
          params: {
            sessionId: FIXTURE_SESSION,
            kind: "metric",
            name: "no-such-metric",
          },
        }),
        res,
      ),
    );
    assert.equal(res._status, 404);
    assert.equal(state.events.length, 0);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
    detach(state);
  }
});

// ─── ADD (W61-add-server) ────────────────────────────────────────────

test("W61-cache-invalidate · addSemanticModelEntry: success path fires hook once with metric kind", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc: ChatDocument | null = makeDoc(makeModel({ version: 4 }));
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  const state = attachListener();
  try {
    const res = fakeRes();
    await silenceConsole(() =>
      addSemanticModelEntry(
        fakeReq({
          email: ADMIN_EMAIL,
          params: { sessionId: FIXTURE_SESSION, kind: "metric" },
          body: makeMetric("gamma", "user"),
        }),
        res,
      ),
    );
    assert.equal(res._status, 200, `expected 200, got ${res._status}`);
    assert.equal(state.events.length, 1);
    assert.deepEqual(state.events[0], {
      sessionId: FIXTURE_SESSION,
      priorVersion: 4,
      nextVersion: 5,
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
    detach(state);
  }
});

test("W61-cache-invalidate · addSemanticModelEntry: success path fires hook once with dimension kind", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc: ChatDocument | null = makeDoc(makeModel({ version: 11, dimensions: [] }));
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  const state = attachListener();
  try {
    const res = fakeRes();
    await silenceConsole(() =>
      addSemanticModelEntry(
        fakeReq({
          email: ADMIN_EMAIL,
          params: { sessionId: FIXTURE_SESSION, kind: "dimension" },
          body: makeDimension("region", "user"),
        }),
        res,
      ),
    );
    assert.equal(res._status, 200, `expected 200, got ${res._status}`);
    assert.equal(state.events.length, 1);
    assert.deepEqual(state.events[0], {
      sessionId: FIXTURE_SESSION,
      priorVersion: 11,
      nextVersion: 12,
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
    detach(state);
  }
});

test("W61-cache-invalidate · addSemanticModelEntry: 409 (name_already_exists) does NOT fire the hook", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(makeModel({ metrics: [makeMetric("alpha")] })),
  );
  const state = attachListener();
  try {
    const res = fakeRes();
    await silenceConsole(() =>
      addSemanticModelEntry(
        fakeReq({
          email: ADMIN_EMAIL,
          params: { sessionId: FIXTURE_SESSION, kind: "metric" },
          body: makeMetric("alpha", "user"),
        }),
        res,
      ),
    );
    assert.equal(res._status, 409);
    assert.equal(state.events.length, 0);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
    detach(state);
  }
});

// ─── Sequential mutations preserve monotone version chain ────────────

test("W61-cache-invalidate · sequential delete then add fire the hook twice with monotone version chain", async () => {
  // Load-bearing: the second mutation sees the FIRST mutation's
  // persisted version as its priorVersion. If the controller failed
  // to wire `priorVersion: nextVersion - 1` correctly (e.g. read
  // `doc.semanticModel.version` AFTER the assignment), the second
  // event's priorVersion would be wrong.
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc: ChatDocument | null = makeDoc(
    makeModel({
      version: 100,
      metrics: [makeMetric("alpha"), makeMetric("beta")],
    }),
  );
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  const state = attachListener();
  try {
    // First: delete alpha.
    await silenceConsole(() =>
      deleteSemanticModelEntry(
        fakeReq({
          email: ADMIN_EMAIL,
          params: {
            sessionId: FIXTURE_SESSION,
            kind: "metric",
            name: "alpha",
          },
        }),
        fakeRes(),
      ),
    );
    // Second: add gamma.
    await silenceConsole(() =>
      addSemanticModelEntry(
        fakeReq({
          email: ADMIN_EMAIL,
          params: { sessionId: FIXTURE_SESSION, kind: "metric" },
          body: makeMetric("gamma", "user"),
        }),
        fakeRes(),
      ),
    );
    assert.equal(state.events.length, 2);
    assert.deepEqual(state.events[0], {
      sessionId: FIXTURE_SESSION,
      priorVersion: 100,
      nextVersion: 101,
    });
    assert.deepEqual(state.events[1], {
      sessionId: FIXTURE_SESSION,
      priorVersion: 101,
      nextVersion: 102,
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
    detach(state);
  }
});
