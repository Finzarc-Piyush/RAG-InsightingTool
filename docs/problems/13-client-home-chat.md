# 13 — Client — Home/chat surface

Wave 2 (P-017, P-047, P-048) + Wave 3 (P-050).

---

### P-017 — `useHomeMutations` AbortController never aborted on unmount

- **Severity:** high
- **Category:** memory / state leak
- **Location:** `client/src/pages/Home/modules/useHomeMutations.ts:82, 546`
- **Evidence:** `abortControllerRef.current` is created per chat mutation but no `useEffect(() => () => ref.current?.abort(), [])` cleanup exists. Unmounting mid-stream leaves the fetch running and tries to update state after unmount.
- **Fix:** Add an unmount-only `useEffect` that aborts whatever controller is current. Also abort the previous controller when starting a new request to enforce single-flight per component.
- **Status:** todo

### P-047 — `handleEditMessage` uses `setTimeout(…, 0)`

- **Severity:** medium
- **Category:** correctness (state / mutation race)
- **Location:** `client/src/pages/Home/modules/useHomeHandlers.ts:67-69`
- **Evidence:** `setTimeout(() => chatMutation.mutate({ …, targetTimestamp }), 0)` after a `setMessages` call. If the state update resolves differently than expected, the wrong `targetTimestamp` is sent.
- **Fix:** Capture the timestamp synchronously from the updater's callback parameter, call `chatMutation.mutate` directly with that captured value — no `setTimeout` needed.
- **Status:** todo

### P-048 — SSE reader lock can leak

- **Severity:** medium
- **Category:** resource leak
- **Location:** `client/src/lib/api/chat.ts:136-183`
- **Evidence:** `response.body.getReader()` creates a locked reader; if an error is thrown before the `while` loop (e.g. during header parsing), `reader.releaseLock()` in the `finally` may run after the stream is already abandoned, but the path where the error is thrown before reader assignment is not covered.
- **Fix:** Assign the reader inside its own `try { reader = response.body.getReader(); try { while (…) … } finally { reader.releaseLock(); } }` to guarantee release on every code path.
- **Status:** todo

### P-050 — Message state unbounded growth

- **Severity:** medium
- **Category:** performance
- **Location:** `client/src/pages/Home/modules/useHomeState.ts:28`
- **Evidence:** `messages` array is append-only; long sessions → large arrays → all consumers re-render everything on each append.
- **Fix:** Introduce a sliding window (keep last 50 in state by default), lazily load older messages from `sessionsApi.getSessionDetails` when the user scrolls up. Cap based on `AGENT_MESSAGES_WINDOW` env (exposed via vite define).
- **Status:** todo
