# Convention: PII-safe discriminant tag on observability events

> Introduced as a soft pattern in Wave WD3-telemetry (2026-05-21), promoted to a codified convention in Wave WI4-telemetry (2026-05-21) on the second instance. See `docs/WAVES.md` for the original contexts.

## Rule

Observability events that need to characterise a value (clicked mark, brushed region, dragged target, hovered cell, …) **never carry the raw value on the wire**. They carry a small fixed-cardinality tag that captures the value's SHAPE without leaking the value itself.

Two canonical tag shapes:

- **`typeof` tag** — for open-ended values whose exact type isn't known ahead of time. JS `typeof` returns one of `"string" | "number" | "boolean" | "object" | "undefined" | "symbol" | "function" | "bigint"`; a small finite set that captures enough signal for observability aggregation without leaking the value. Used by WD3-telemetry's `valueType: typeof detail.value` on the drill-through endpoint.
- **Discriminant tag** — for values from a known closed-set discriminated union. The discriminant kind (the `region.kind` field of a `BrushRegion`, the `type` field of a tagged union, etc.) is itself the smallest informative token. Used by WI4-telemetry's `regionKind: detail.region.kind` on the explain-slice endpoint (`"numeric" | "temporal" | "categorical" | "box2d"`).

Choose the tag shape based on the value:

- If the value comes from JS code with potentially-unknown types (e.g. column values from a user's dataset), use `typeof`.
- If the value carries a typed discriminant from a union (BrushRegion, ChartSpec, ActiveFilter, etc.), use the discriminant's kind field.

## Why

Observability events are written to a Cosmos `usage_events` container that's read by aggregation queries, possibly indexed for analytics, possibly exported for third-party analysis. Each of those downstream consumers is a potential PII leak surface. The conservative move is to **never put column values, brush bounds, or any user-derived content into observability events** — even if the immediate use case looks benign, the cumulative risk of "any field on the wire might end up indexed somewhere" is high enough to warrant a blanket prohibition.

What we DO want to know from observability is the distribution of value shapes: "what `typeof` are columns getting drilled into" (mostly strings? mostly numbers?) or "what `BrushRegion` kind is most-used" (categorical brushes dominate? Or temporal? Or 2D scatter?). The tag captures the shape; the value stays in the user's dataset where it belongs.

Alternatives considered and rejected:

- **Coerce via a server-side canonicaliser and send a bucket name** — adds runtime dependency on the canonicaliser at the call site, breaks the cross-runtime-boundary local-mirror convention, no observability benefit over the raw tag.
- **Hash the raw value via SHA-256 and send the prefix** — preserves uniqueness for aggregation but the hash leaks information: two same-value clicks emit the same hash; a small-cardinality column reveals its value distribution.
- **Send a length-bucketed string** (`"short" | "medium" | "long"`) — useless for numeric columns, confuses temporal observability.

The `typeof` / discriminant tag is the smallest informative token.

## How to apply

When adding a new observability event that needs to characterise a value:

1. Look at the value's type at the call site. Is it from a JS runtime with potentially-unknown types? → `typeof`. Is it from a TypeScript discriminated union? → discriminant `kind` field.
2. Add the tag as a top-level field on the payload (e.g. `valueType: typeof detail.value`, `regionKind: detail.region.kind`). NOT inside a nested `metadata.value` slot — top-level is easier to query in Cosmos.
3. Verify in the client helper's PII test that `Object.keys(body).sort()` is exactly the canonical set — the test pins the absence of any raw-value field at runtime, catching a future caller that accidentally adds `value: detail.value` thinking it was being helpful.
4. Document the PII contract inline on BOTH the route handler AND the client helper: column NAMES go on the wire (dataset schema, public), column VALUES never do (only their tag).

For values that don't fit either tag shape (e.g. a chart-kind name "bar" / "line" / "scatter" — that's neither a `typeof` nor a discriminant on the value, it's metadata ABOUT the chart), send the metadata field directly under the same closed-cardinality discipline — it's not a PII leak because it's not user-derived content.

## Related

- [Wave WD3-telemetry entry](../WAVES.md) — first instance (`valueType: typeof detail.value` on the drill-through endpoint).
- [Wave WI4-telemetry entry](../WAVES.md) — second instance + codification (`regionKind: detail.region.kind` on the explain-slice endpoint).
- Files: [`server/routes/telemetry.ts`](../../server/routes/telemetry.ts), [`client/src/lib/telemetry.ts`](../../client/src/lib/telemetry.ts), [`client/src/pages/Dashboard/Components/DashboardView.tsx`](../../client/src/pages/Dashboard/Components/DashboardView.tsx).
- Adjacent: [`docs/conventions/strict-zod-on-observability-endpoints.md`](strict-zod-on-observability-endpoints.md) — the strict-keys-rejection that catches a future caller leaking the raw value.
