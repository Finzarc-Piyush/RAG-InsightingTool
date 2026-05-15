/**
 * Wave E1 · BroadcastChannel-based cross-tab synchronization for session
 * state. When the same session is open in two browser tabs and one tab
 * writes to the server (active filter, hierarchy update, new chat turn,
 * permanent context edit), the other tab silently diverges — its lifted
 * state stays at the pre-write snapshot.
 *
 * Pre-E1 the user would see:
 *   - Tab A applies an active filter → server bumps `activeFilter.version`
 *   - Tab B then runs a pivot query keyed on the OLD version → 400
 *     "active_filter_version_mismatch" (until Wave E4 lands a graceful
 *     retry; today the response just fails)
 *   - Tab A adds a hierarchy in chat → Tab B's H6 banner doesn't update
 *   - Tab A's turn-end persist updates `priorInvestigations` → Tab B's
 *     PriorInvestigationsBanner stays stale
 *
 * The fix uses the browser-native `BroadcastChannel` API (no library,
 * works in all modern browsers including Safari ≥ 15). One channel per
 * sessionId; messages are typed envelopes `SessionBroadcastEvent`. Tabs
 * subscribe via the `useSessionBroadcast` hook in
 * `client/src/lib/sessionBroadcast.hook.ts` (separate file to keep this
 * one framework-agnostic for unit testing).
 *
 * Multi-tab support is single-instance correctness only — this works
 * within ONE browser, not across browsers or devices. The cross-device
 * version would need a server-side push channel (SSE / WebSocket) on
 * the session, which is explicitly out of scope.
 */

/** All possible cross-tab event types. New types must extend this union. */
export type SessionBroadcastEventKind =
  | "active_filter" // server-side activeFilter.version changed (PUT / DELETE)
  | "messages" // a new assistant message was appended (turn completed)
  | "columns" // dataSummary.columns changed (data-ops persist)
  | "hierarchies" // dimensionHierarchies changed (user declared or removed)
  | "permanent_context"; // chatDocument.permanentContext changed

export interface SessionBroadcastEvent {
  kind: SessionBroadcastEventKind;
  /** Wall-clock ms at emit time. Receivers can dedupe by recency. */
  at: number;
  /**
   * Optional sender id so the emitting tab can ignore its own echo
   * (BroadcastChannel echoes messages back to the sender? — no, it
   * doesn't, but defensive in case a future polyfill does).
   */
  senderId?: string;
}

/**
 * Wave E1 · Per-CALL BroadcastChannel allocation (no module-level cache).
 *
 * Each `openSessionChannel` opens a fresh `BroadcastChannel` because Node's
 * BroadcastChannel implementation only delivers messages to OTHER channel
 * instances with the same name — emit-then-subscribe on the SAME object
 * is a no-op. Caching the channel meant two surfaces in the same tab
 * couldn't act as peer tabs in tests. Per-call allocation is also more
 * test-friendly and the production overhead is negligible (BroadcastChannel
 * is a cheap browser primitive; one extra instance per surface).
 *
 * Tracked in a module-level set so `__resetSessionBroadcastChannelsForTesting`
 * can close every open channel between tests.
 */
const openChannels = new Set<BroadcastChannel>();

function channelName(sessionId: string): string {
  return `session:${sessionId}`;
}

function randomSenderId(): string {
  // Plenty of entropy for the per-tab "did I send this" check.
  return `tab_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

/**
 * Returns a cached or newly-opened channel for the given session.
 * The caller MUST eventually call the returned unsubscribe lambda to
 * release the refcount (typically inside a React `useEffect` cleanup).
 */
export function openSessionChannel(sessionId: string): {
  emit: (kind: SessionBroadcastEventKind) => void;
  subscribe: (handler: (event: SessionBroadcastEvent) => void) => () => void;
  release: () => void;
} {
  if (typeof BroadcastChannel === "undefined") {
    // Older browsers / Node test envs. No-op surface so callers don't
    // need to defensive-check.
    return {
      emit: () => {
        /* no-op */
      },
      subscribe: () => () => {
        /* no-op */
      },
      release: () => {
        /* no-op */
      },
    };
  }

  const name = channelName(sessionId);
  const channel = new BroadcastChannel(name);
  openChannels.add(channel);
  const senderId = randomSenderId();

  return {
    emit(kind) {
      const event: SessionBroadcastEvent = {
        kind,
        at: Date.now(),
        senderId,
      };
      try {
        channel.postMessage(event);
      } catch {
        /* channel closed mid-emit; ignore */
      }
    },
    subscribe(handler) {
      const wrapped = (ev: MessageEvent<SessionBroadcastEvent>) => {
        const data = ev.data;
        if (!data || typeof data !== "object") return;
        // Ignore our own echo if the runtime happens to deliver it.
        if (data.senderId === senderId) return;
        try {
          handler(data);
        } catch {
          /* handler errors must never leak into other subscribers */
        }
      };
      channel.addEventListener("message", wrapped);
      return () => {
        channel.removeEventListener("message", wrapped);
      };
    },
    release() {
      try {
        channel.close();
      } catch {
        /* already closed */
      }
      openChannels.delete(channel);
    },
  };
}

/**
 * Test-only: drop every open channel. Used in unit tests that re-mount
 * subscribers and need deterministic state.
 */
export function __resetSessionBroadcastChannelsForTesting(): void {
  for (const ch of openChannels) {
    try {
      ch.close();
    } catch {
      /* ignore */
    }
  }
  openChannels.clear();
}
