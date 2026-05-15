/**
 * Wave E1 · React hook wrapper around `openSessionChannel`. Subscribes
 * to the per-session BroadcastChannel and routes incoming events to a
 * caller-supplied handler. Returns an `emit` function the caller uses
 * to broadcast its OWN writes to peer tabs.
 *
 * Usage (e.g. inside the Home page):
 *
 *   const { emitSessionBroadcast } = useSessionBroadcast(sessionId, (event) => {
 *     switch (event.kind) {
 *       case "active_filter":
 *         queryClient.invalidateQueries({ queryKey: ["activeFilter", sessionId] });
 *         break;
 *       case "messages":
 *         refetchMessages();
 *         break;
 *       // …
 *     }
 *   });
 *
 *   // Later, after a successful filter PUT:
 *   emitSessionBroadcast("active_filter");
 */
import { useEffect, useRef } from "react";
import {
  openSessionChannel,
  type SessionBroadcastEvent,
  type SessionBroadcastEventKind,
} from "./sessionBroadcast";

export function useSessionBroadcast(
  sessionId: string | null | undefined,
  handler: (event: SessionBroadcastEvent) => void
): {
  emitSessionBroadcast: (kind: SessionBroadcastEventKind) => void;
} {
  // Refs let the callback see the latest handler without re-subscribing
  // on every render. Common React-hook idiom.
  const handlerRef = useRef(handler);
  const emitRef = useRef<((kind: SessionBroadcastEventKind) => void) | null>(
    null
  );

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!sessionId) return;
    const ch = openSessionChannel(sessionId);
    emitRef.current = ch.emit;
    const unsubscribe = ch.subscribe((event) => {
      try {
        handlerRef.current(event);
      } catch {
        /* handler errors stay scoped */
      }
    });
    return () => {
      unsubscribe();
      ch.release();
      emitRef.current = null;
    };
  }, [sessionId]);

  return {
    emitSessionBroadcast: (kind) => {
      // Capture the current emit; if the channel has been released
      // (mid-unmount), silently no-op.
      emitRef.current?.(kind);
    },
  };
}
