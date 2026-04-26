/**
 * AsyncLocalStorage-backed request context. Carries `{ sessionId, userId, turnId }`
 * across await boundaries so downstream code (e.g. the LLM usage sink) can
 * stamp outgoing telemetry with identity without every call site having to
 * thread the values through.
 *
 * Integration: the chat-stream route wraps its handler in `withRequestContext`
 * once the session is resolved. Until that wiring exists, `getRequestContext()`
 * returns an empty object — rows are written with best-effort metadata.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  sessionId?: string;
  userId?: string;
  turnId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with the supplied context bound for the duration of its async scope.
 * Child async operations (awaited promises, timers, etc.) inherit the context.
 */
export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Returns the current context or an empty object. Never throws. */
export function getRequestContext(): RequestContext {
  return storage.getStore() ?? {};
}

/**
 * Replace a field on the currently-running context. No-op if no context is
 * bound (e.g. called from code running outside a `withRequestContext` scope).
 * Useful for setting `turnId` after the enclosing scope has already started.
 */
export function updateRequestContext(patch: Partial<RequestContext>): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  Object.assign(ctx, patch);
}
