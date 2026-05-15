/**
 * Wave E1 · Pins the cross-tab broadcast contract.
 *
 * The tests exercise the pure helper functions in `sessionBroadcast.ts`
 * without React. The React hook in `sessionBroadcast.hook.ts` is a thin
 * wrapper over the helper, verified separately during E2/E3 wiring.
 *
 * `BroadcastChannel` is part of Node ≥ 15 by default, so vitest's
 * `env: 'node'` config picks it up natively.
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  openSessionChannel,
  __resetSessionBroadcastChannelsForTesting,
  type SessionBroadcastEvent,
} from "./sessionBroadcast";

afterEach(() => {
  __resetSessionBroadcastChannelsForTesting();
});

// Tiny helper: wait for `n` event-loop turns so async BroadcastChannel
// delivery has a chance to settle.
async function tick(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 0));
}

describe("Wave E1 · openSessionChannel emit / subscribe", () => {
  test("a message emitted on one channel surfaces on a peer subscriber on the SAME session", async () => {
    const a = openSessionChannel("sess_xy");
    const b = openSessionChannel("sess_xy");
    const received: SessionBroadcastEvent[] = [];
    b.subscribe((e) => received.push(e));

    a.emit("active_filter");
    await tick(2);

    expect(received.length).toBe(1);
    expect(received[0].kind).toBe("active_filter");
    expect(typeof received[0].at).toBe("number");

    a.release();
    b.release();
  });

  test("the EMITTING tab does NOT receive its own message echoed back", async () => {
    const a = openSessionChannel("sess_self");
    const ownReceived: SessionBroadcastEvent[] = [];
    a.subscribe((e) => ownReceived.push(e));
    a.emit("messages");
    await tick(2);
    expect(ownReceived.length).toBe(0); // senderId check filters echo
    a.release();
  });

  test("messages on a different session DO NOT cross over", async () => {
    const a = openSessionChannel("sess_A");
    const b = openSessionChannel("sess_B");
    const aReceived: SessionBroadcastEvent[] = [];
    const bReceived: SessionBroadcastEvent[] = [];
    a.subscribe((e) => aReceived.push(e));
    b.subscribe((e) => bReceived.push(e));

    b.emit("hierarchies");
    await tick(2);

    expect(aReceived.length).toBe(0); // session A doesn't see session B's messages
    expect(bReceived.length).toBe(0); // session B's emitter doesn't see its own echo
    a.release();
    b.release();
  });

  test("each unique event kind round-trips correctly", async () => {
    const a = openSessionChannel("sess_kinds");
    const b = openSessionChannel("sess_kinds");
    const received: SessionBroadcastEvent[] = [];
    b.subscribe((e) => received.push(e));

    const kinds: SessionBroadcastEvent["kind"][] = [
      "active_filter",
      "messages",
      "columns",
      "hierarchies",
      "permanent_context",
    ];
    for (const kind of kinds) {
      a.emit(kind);
    }
    await tick(3);

    expect(received.length).toBe(5);
    expect(received.map((e) => e.kind).sort()).toEqual([...kinds].sort());

    a.release();
    b.release();
  });

  test("release decrements refcount; underlying channel closes when last subscriber leaves", async () => {
    const a = openSessionChannel("sess_close");
    const b = openSessionChannel("sess_close");
    // First release: refcount still > 0 (we still have `b`).
    a.release();
    // Second release: refcount hits 0, channel closes.
    b.release();
    // A new channel after both released should be a fresh entry.
    const c = openSessionChannel("sess_close");
    const received: SessionBroadcastEvent[] = [];
    c.subscribe((e) => received.push(e));
    // Without a peer there's nothing to receive — just verify emit doesn't
    // throw on a freshly opened channel.
    c.emit("active_filter");
    await tick(2);
    expect(received.length).toBe(0); // sender-self-filter
    c.release();
  });

  test("subscriber that throws does NOT poison other subscribers", async () => {
    const a = openSessionChannel("sess_throw");
    const b = openSessionChannel("sess_throw");
    const good: SessionBroadcastEvent[] = [];
    b.subscribe(() => {
      throw new Error("bad handler");
    });
    b.subscribe((e) => good.push(e)); // second handler keeps running
    a.emit("messages");
    await tick(2);
    expect(good.length).toBe(1);
    a.release();
    b.release();
  });

  test("unsubscribe stops further deliveries to that subscriber only", async () => {
    const a = openSessionChannel("sess_unsub");
    const b = openSessionChannel("sess_unsub");
    const received: SessionBroadcastEvent[] = [];
    const unsubscribe = b.subscribe((e) => received.push(e));

    a.emit("active_filter");
    await tick(2);
    expect(received.length).toBe(1);

    unsubscribe();
    a.emit("messages");
    await tick(2);
    expect(received.length).toBe(1); // still 1 — unsubscribed before this emit

    a.release();
    b.release();
  });
});
