# 03 — Agent runtime correctness & robustness

Wave 2. Applies to `server/lib/agents/**` and the chat-streaming pipeline that hosts it.

---

### P-008 — No outer timeout on `processStreamChat`

- **Severity:** high
- **Category:** hardening / resource
- **Location:** `server/services/chat/chatStream.service.ts:268-end`
- **Evidence:** Internal agent-loop deadlines exist (`AGENT_MAX_WALL_MS`), but if the loop exits abnormally or a downstream await hangs, the SSE response is never closed. Clients hang indefinitely.
- **Fix:** Wrap the top-level streaming call in `Promise.race` with a wall-clock timeout (config-controlled, default ~150s). On timeout, emit an error SSE frame (`event: error`), call `res.end()`, and log.
- **Status:** todo

### P-018 — `chatWithAIStream` returns silently on bad payload

- **Severity:** medium
- **Category:** correctness
- **Location:** `server/controllers/chatController.ts:63-64`
- **Evidence:** Missing `sessionId`/`message` triggers a bare `return;` after headers may already be flushed — no HTTP 400, no SSE error.
- **Fix:** Validate payload before any `setSSEHeaders`. Return HTTP 400 with a descriptive body if pre-headers; else send a terminal `event: error` SSE frame and `res.end()`.
- **Status:** todo

### P-020 — Hardcoded while-loop budgets in agent runtime

- **Severity:** medium
- **Category:** config
- **Location:** `server/lib/agents/runtime/agentLoop.service.ts:614, 843, 1249`
- **Evidence:** `while (replans <= 2)`, verifier per-step / final rounds fixed in code rather than read from `AgentConfig`.
- **Fix:** Promote to `AgentConfig` fields (`maxReplans`, already have `maxVerifierRoundsPerStep` / `maxVerifierRoundsFinal`) with env overrides. Keep defaults identical so behavior is unchanged.
- **Status:** todo

### P-021 — LLM-JSON repair gives up after two parses

- **Severity:** medium
- **Category:** correctness
- **Location:** `server/lib/agents/runtime/llmJson.ts:39-59`
- **Evidence:** One initial + one repair attempt; otherwise returns `{ ok: false, error }`. The whole turn then aborts even when a minimal plan could have been extracted.
- **Fix:** Add a third pass against a reduced / minimal schema subset, return partial-plan status, let the caller decide whether to proceed.
- **Status:** todo

### P-026 — `sendSSE` return value ignored everywhere

- **Severity:** medium
- **Category:** correctness
- **Location:** all callers of `server/utils/sse.helper.ts:13-41`
- **Evidence:** `sendSSE` returns `false` when the connection is closed; callers continue doing work and producing more frames that go nowhere.
- **Fix:** Track a `connectionClosed` flag per request; short-circuit the agent turn when `sendSSE` first returns `false`. Log one line with `sessionId` + stage on first close.
- **Status:** todo

### P-032 — Executor does not pre-validate column existence

- **Severity:** medium
- **Category:** correctness
- **Location:** `server/lib/agents/runtime/tools/registerTools.ts`, `executeQueryPlanArgsSchema`
- **Evidence:** Unknown columns surface as DuckDB SQL errors, deep in the stack, mid-flight. The planner never learns "that column doesn't exist" cleanly.
- **Fix:** Validate all referenced columns against the session's `dataSummary.columns` before dispatching to DuckDB. Return a structured `ColumnNotFound` that the planner can replan against.
- **Status:** todo
