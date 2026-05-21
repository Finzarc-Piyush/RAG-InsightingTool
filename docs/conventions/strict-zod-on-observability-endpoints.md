# Convention: Strict zod body schema on observability endpoints

> Introduced as a soft pattern in Wave WD3-telemetry (2026-05-21), promoted to a codified convention in Wave WI4-telemetry (2026-05-21) on the second instance. See `docs/WAVES.md` for the original contexts.

## Rule

Observability endpoint request bodies are validated with `.strict()` zod schemas. Any extra top-level key in the request body triggers a 400 response and the observability call is NOT fired.

```ts
export const xxxTelemetryRequestSchema = z
  .object({
    chartId: z.string().min(1),
    column: z.string().min(1),
    valueType: z.string().min(1),       // or regionKind: z.enum([...]) — see below
    dashboardId: z.string().min(1).optional(),
  })
  .strict();
```

The `.strict()` is load-bearing — it's the defense against a future caller (or upstream renderer bug) leaking raw values into the observability payload.

When the field is a known closed-set (e.g. a discriminated-union kind), prefer `z.enum([...])` over `z.string().min(1)`:

```ts
regionKind: z.enum(["numeric", "temporal", "categorical", "box2d"]),
```

The enum narrowing is additional defense in depth — it catches a future caller that smuggles a non-discriminant token through the schema layer.

## Why

Observability endpoints have a stronger PII contract than data endpoints. Where a data endpoint might legitimately accept extra forward-compat fields (a new optional `metadata.industryVertical` that older clients don't send), an observability endpoint should NEVER accept fields it doesn't know about — because every accepted field is a potential PII leak surface (Cosmos persists what you send it, downstream aggregators index what's in Cosmos, third-party analytics consume what's exposed).

Two specific risks the strict gate defends against:

1. **A future renderer or client helper adds a `value: detail.value` field "for richer observability"**, accidentally leaking the raw column value into Cosmos. The strict gate catches it at the route layer (400 response) before any data leaves the client, surfaces as a development-time error rather than a silent prod leak.
2. **An attacker who controls the client-side payload (via XSS or compromised browser extension) tries to use the telemetry endpoint as a data exfiltration channel** by stuffing arbitrary fields into the body. The strict gate caps the exfiltration surface at the four canonical fields; the auth gate ensures the payload is attributed to the user; the PII contract limits each field's content to non-sensitive metadata.

Alternatives considered and rejected:

- **Use a non-strict schema and rely on the server to project out unknown fields before persisting** — works for the persist step but doesn't protect against an attacker reading the request body BEFORE persistence (logging middleware, request-ID injection, header echoing in error responses, etc. all see the full body). Strict-at-the-edge is the right shape.
- **Use a strict schema only on top-level keys but allow `.passthrough()` on nested objects** — defeats the purpose; nested fields are equally PII-risky.
- **Drop the strict check in production and keep it in dev/test as a lint** — defeats the purpose; the production path IS the risk surface.

## How to apply

When adding a new observability endpoint:

1. Declare the request schema with `.strict()`:
   ```ts
   export const myTelemetryRequestSchema = z.object({ ... }).strict();
   ```
2. Use `z.enum([...])` for any field whose valid set is a known closed-set discriminant. Use `z.string().min(1)` for open-ended tags like `typeof` (which has 8 well-defined possible values but is conceptually open to JS spec extensions).
3. Write a schema test that pins:
   - Minimal valid case parses.
   - Each required field's absence rejects.
   - Strict-extra-keys rejects with a stray field whose name reads like a PII leak (`value: "raw..."`, `regionStart: 0`, etc.) — the test commentary documents the contract at the assertion level.
   - For enum fields: unknown enum values reject.
4. Write a controller test that pins:
   - 400 on malformed body → `recordedCalls.length === 0` (no telemetry fire).
   - 400 on strict-extra-keys → `recordedCalls.length === 0`.
5. Document the PII contract inline on the route handler and on the client helper.

## Related

- [Wave WD3-telemetry entry](../WAVES.md) — first instance (`drillThroughTelemetryRequestSchema.strict()`).
- [Wave WI4-telemetry entry](../WAVES.md) — second instance + codification (`explainSliceTelemetryRequestSchema.strict()` with `z.enum()` on `regionKind`).
- Files: [`server/routes/telemetry.ts`](../../server/routes/telemetry.ts).
- Adjacent: [`docs/conventions/pii-safe-discriminant-tag-on-observability-events.md`](pii-safe-discriminant-tag-on-observability-events.md) — the PII-safe tag convention that the strict schema gates.
- Adjacent: [`docs/conventions/route-level-recorder-seam.md`](route-level-recorder-seam.md) — the test-substitution seam that the strict-schema tests rely on for the "no telemetry fire" assertion.
