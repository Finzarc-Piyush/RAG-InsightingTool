# Convention: Click-time context capture on event detail

> Introduced as a soft pattern in Wave WD3-server-sheetId-resolution (2026-05-21), promoted to a codified convention in Wave WI4-client-sheetId-resolution (2026-05-22) on the second instance. See `docs/WAVES.md` for the original contexts.

## Rule

When a UI surface dispatches a `CustomEvent` that will be consumed by a panel / sheet / drawer / modal which **does not render synchronously with the dispatch**, and that consumer needs to resolve against a context value that **could drift** between dispatch time and render time (active sheet, active mode, active filter snapshot, current dataset version, viewport state, …), the listener captures the context **at dispatch time** by spreading it onto the event detail before storing it in React state.

Concrete shape — conditional spread at the listener:

```tsx
window.addEventListener(EVENT_NAME, (event) => {
  const detail = (event as CustomEvent<MyEvent>).detail;
  // validation guards omitted for brevity
  setMyEventState(
    activeContextValue ? { ...detail, contextField: activeContextValue } : detail,
  );
});
```

The receiving panel resolves against the captured context field on the stored state (the value frozen at dispatch time), **NOT** against the current active-context value from React state.

The conditional-spread (rather than unconditional injection) preserves the pre-wave event shape verbatim when the context value is null/undefined (degenerate mid-mount cases, callers that pre-date the field) — backwards-compat for any existing event consumer.

## Why

The event represents **what the user clicked / brushed / dragged** — a frozen-in-time intent. The consumer panel renders **that intent**, regardless of subsequent state changes. Two failure modes drive the rule:

1. **Drift between dispatch and render.** Modal-ish panels (Radix Sheet, Drawer, Dialog) often render on the next tick or behind an animation; if the user clicks on Sheet 1 and the dashboard re-renders with a different `activeSheetId` before the panel mounts, a panel that reads the *current* `activeSheetId` resolves against the new sheet's chart. Capturing at dispatch time freezes the resolution context.
2. **Drift between dispatch and unmount.** Even after the panel mounts, the user can navigate / change state while the panel is open. A panel that re-resolves on every render walks a moving target. The captured value is stable until the panel closes and clears the event.

Both failure modes are silent — the panel renders something plausible but wrong, no error surfaces, the user doesn't notice the mismatch unless they compare against a known reference. Click-time capture is the smallest defensible structural fix.

Alternatives considered and rejected:

- **Pass the active-context value as a separate prop on the panel.** Two-prop drift surface: panel reads `event.x` from the event prop AND `contextValue` from a separate prop; the two can diverge if the parent mis-wires them. Also doesn't defend against the dispatch-to-render drift (the prop carries the CURRENT context value, not the dispatch-time one).
- **Re-derive the context at render time inside the panel.** Same dispatch-to-render drift surface — render reads whatever the active context is at render time, not at dispatch time.
- **Store the captured context in a parallel `useRef`.** Works but spreads the "what was captured" state across two slots (event detail + ref); harder to debug, easy to forget to clear the ref on event close.
- **Always inject the context value (no conditional spread).** Forces every consumer to handle the new field, breaks backwards-compat for any handler that does `assert.match(/setEventState\(detail\)/)` source-inspection or any test that pins the pre-wave shape.

The conditional spread is the smallest viable expression: one ternary, no new state slots, preserves pre-wave shape for the null-context branch.

## How to apply

When dispatching a `CustomEvent` whose consumer panel needs a drift-stable context value:

1. **Add `contextField?: TYPE`** as an optional field on the event interface. JSDoc the three load-bearing invariants: (i) injected by the LISTENER, not the dispatching renderer (renderers don't have the dashboard-level context in scope); (ii) captured at dispatch time, NOT render time; (iii) undefined branch preserves backwards-compat.
2. **At the listener** (the canonical "received the intent, decide what to do" boundary — typically a top-level `useEffect` in a dashboard host component), change `setEventState(detail)` to `setEventState(activeContext ? { ...detail, contextField: activeContext } : detail)`.
3. **Verify the effect's deps array includes the context value.** Without this, the listener closes over a stale context from the mount-time closure and every subsequent event captures the same (wrong) value. Add a source-inspection test that pins the deps array.
4. **At the consumer** (panel / sheet / drawer), resolve against the captured context field on the event (the frozen value). If the consumer needs a fallback for events that lack it (legacy event shape, degenerate mid-mount case), the fallback branch resolves against the current state's context value — but the JSDoc should pin that this is for backwards-compat only.
5. **Pin the conditional-spread shape with source-inspection tests:**
   - Positive pin: regex match `setEventState\(\s*activeContext \? \{ \.\.\.detail, contextField: activeContext \} : detail,?\s*\);`
   - Negative pin: regex doesNotMatch `setEventState\(detail\);` (defense against a future refactor that accidentally reverts the conditional spread)
6. **Apply [predictable-failure-on-optional-disambiguator](predictable-failure-on-optional-disambiguator.md)** to the consumer's resolution: a captured-but-now-stale context value (e.g. the captured sheet was deleted between dispatch and render) returns null rather than silently falling back. The two conventions compose naturally — click-time-capture is how the disambiguator gets onto the event in the first place; predictable-failure is how the resolver handles the case where the captured value no longer maps to a real entity.

For event paths where the consumer renders synchronously with the dispatch (or where the context value can't drift — e.g. the consumer is a pure synchronous handler that completes before any state change), this convention does not apply; capture-at-render is fine.

## Related

- [Wave WD3-server-sheetId-resolution entry](../WAVES.md) — first instance. DashboardView listener captures `activeSheetId` onto the `DrillThroughEvent` detail via `setDrillThroughEvent(activeSheetId ? { ...detail, sheetId: activeSheetId } : detail)`. Pinned by source-inspection tests in [`server/tests/dashboardDrillThroughWD3SheetIdResolution.test.ts`](../../server/tests/dashboardDrillThroughWD3SheetIdResolution.test.ts) + [`client/src/pages/Dashboard/lib/wd3Sheet.test.ts`](../../client/src/pages/Dashboard/lib/wd3Sheet.test.ts).
- [Wave WI4-client-sheetId-resolution entry](../WAVES.md) — second instance + codification. DashboardView listener captures `activeSheetId` onto the `ExplainSliceEvent` detail via the byte-identical conditional-spread shape. Pinned by source-inspection tests in [`client/src/pages/Dashboard/lib/wi4SheetIdResolution.test.ts`](../../client/src/pages/Dashboard/lib/wi4SheetIdResolution.test.ts) + [`client/src/pages/Dashboard/lib/wi4Panel.test.ts`](../../client/src/pages/Dashboard/lib/wi4Panel.test.ts).
- Files: [`client/src/pages/Dashboard/Components/DashboardView.tsx`](../../client/src/pages/Dashboard/Components/DashboardView.tsx), [`client/src/pages/Dashboard/lib/drillThrough.ts`](../../client/src/pages/Dashboard/lib/drillThrough.ts), [`client/src/pages/Dashboard/lib/explainSlice.ts`](../../client/src/pages/Dashboard/lib/explainSlice.ts).
- Adjacent: [`docs/conventions/predictable-failure-on-optional-disambiguator.md`](predictable-failure-on-optional-disambiguator.md) — the consumer-side resolver's handling of captured-but-now-stale context values. The two conventions are the dispatch-side + consume-side halves of the same drift-stable-resolution contract.
