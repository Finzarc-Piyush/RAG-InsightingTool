# Decision-gated infrastructure migrations (the ones we do NOT flip blind)

**Status:** Accepted (decisions recorded) · the 6 findings below remain **PARTIAL /
decision-gated** in the remediation tracker — **NOT done**.

## Context

The 2026-06-15 expert audit surfaced six findings whose *fix is known* but whose
*execution touches live, multi-tenant state* — the production Cosmos chats
container, the serverless (Vercel) deployment target, and the per-request data
hot path. Each is the kind of change a careful operator does **not** flip
autonomously on a running system: a wrong cutover can silently lose chat history,
double-process uploads, weaken an abuse limiter, or OOM ingestion at scale.

This ADR records, for all six, the *same shaped decision*: **stage behind a flag
or document the gap; do not flip blind.** It exists so these are not re-litigated
as "quick wins" and so the safe migration path is written down before infra +
product sign-off make execution possible.

All six are tracked as 🟦 STAGED / 🟡 PARTIAL (NOT ✅ DONE) in
[`docs/expert-audit/REMEDIATION-TRACKER.md`](../expert-audit/REMEDIATION-TRACKER.md)
(waves EX8 / EX9 / EX10 / EX12) and roll up under the "hard core is staged, not
faked" decision in [`expert-audit-remediation.md`](./expert-audit-remediation.md).
The honest tracker is the deliverable; this ADR is its design backing.

---

## DATA-1 — Cosmos partition key is `username` but the hot path queries by `sessionId`

**Problem.** The chats container is partitioned on `/fsmrora` (set to the user's
email in [`../../server/models/chat.model.ts`](../../server/models/chat.model.ts)),
but the hot read `getChatBySessionIdEfficient` runs
`SELECT * FROM c WHERE c.sessionId = @sessionId` — a **cross-partition** query on
every chat-doc read (fan-out across all partitions, higher RU + latency).

**Decision.** Document the cross-partition cost; do **not** attempt an in-place
repartition. A live Cosmos container's partition key path is immutable — you
cannot repartition it in place.

**Migration path (when infra sign-off is available).**
1. Provision a **new** container partitioned by `/sessionId` (or make the doc
   `id == sessionId` so the hot read becomes a point read — see DATA-6).
2. **Dual-write** new + old containers behind a flag so neither is canonical
   mid-migration.
3. **Backfill** existing docs into the new container (keyed by `sessionId`).
4. **Cutover** reads to the new container; verify; retire the old container.

**Risk if flipped blind.** There is no "flip" — attempting to change the key on
the live container is rejected by Cosmos; a naive recreate without dual-write +
backfill **loses all existing chat history**.

---

## DATA-6 — Multiple chat docs per session tolerated; deletes brute-force partition keys

**Problem.** `getChatBySessionIdEfficient` tolerates (and only `warn`-logs) more
than one document for a `sessionId`, picking the latest by `lastUpdatedAt`.
Document `id`s are random, so `deleteChatBySessionId`
([`../../server/models/chat.model.ts`](../../server/models/chat.model.ts)) brute-forces
a list of candidate partition-key values until a delete succeeds.

**Decision.** Make the doc `id == sessionId` **deterministic** (create-if-not-exists
idempotency on write → at most one doc per session; point-read delete instead of
brute-force). This ties into DATA-1 (deterministic id ⇒ point reads). It is
**migration-sensitive** — existing docs already have random ids — so it is
**backfill-gated**, not a blind switch.

**Migration path.**
1. Land the deterministic-id write path (`id = sessionId`, upsert / create-if-not-exists)
   behind the same flag as DATA-1's dual-write.
2. **Backfill**: re-key existing docs to `id == sessionId` (dedupe sessions that
   currently have multiple docs, keeping the latest by `lastUpdatedAt`).
3. Switch deletes to point reads (`item(sessionId, pk).delete()`); drop the
   brute-force partition-key loop.

**Risk if flipped blind.** Switching to `id == sessionId` against the existing
store collides on the first write to any pre-existing session (or silently
shadows the old random-id doc), and the dedupe step done wrong **drops live chat
documents**.

---

## DATA-2 — In-process upload queue + fire-and-forget is incompatible with serverless

**Problem.** The upload pipeline ([`../../server/utils/uploadQueue.ts`](../../server/utils/uploadQueue.ts))
holds jobs in an in-process `Map` and processes them fire-and-forget after the
HTTP response returns. On Vercel a function instance can be frozen/recycled the
moment the response is sent, so the background work is **not guaranteed to run**,
and a status poll can land on a different instance that never saw the job.

**Decision.** Do not pretend the in-process queue is durable on serverless.
Stage the durable runner; in the interim, drive status from the **Cosmos doc's
`enrichmentStatus`**, not the in-memory `Map` — the doc-status read is **already
feasible today** (the doc carries `enrichmentStatus: in_progress | complete | failed`).

**Migration path.**
1. **Durable job runner**: enqueue to an Azure **Storage Queue / Service Bus** and
   process in a **Container App / Functions worker** that is not tied to the
   request lifecycle; OR
2. **Doc-driven status (lower lift, available now)**: persist progress to the
   chat doc and have clients **poll the doc's `enrichmentStatus`** rather than the
   in-memory job map — survives instance recycling with no new infra.

**Risk if flipped blind.** Trusting the in-process queue on serverless **silently
drops uploads** (work never completes after the response is flushed) and returns
"job not found" on polls that hit a cold instance.

---

## PERF-7 — Rate limiter + upload-job state are per-instance in-memory

**Problem.** The API rate limiter ([`../../server/index.ts`](../../server/index.ts))
uses `express-rate-limit`'s default in-memory store, and the SSE connection cap
([`../../server/middleware/sseLimiter.ts`](../../server/middleware/sseLimiter.ts))
plus the upload-job state ([`../../server/utils/uploadQueue.ts`](../../server/utils/uploadQueue.ts))
are per-instance `Map`s. On multi-instance serverless the effective limit becomes
`max × instance_count` (each instance counts independently), the upload concurrency
cap is not globally enforced, and status polling is instance-pinned.

**Decision.** Back both with a **shared store** when infra is available. At
minimum, **document the multiplied effective limit** and **persist job status in
Cosmos** (DATA-2's doc-driven status) so a poll is correct regardless of which
instance serves it.

**Migration path.**
1. Move the rate limiter to a shared backing store (Redis or Cosmos) so the window
   is counted **globally** across instances.
2. Persist upload-job status in Cosmos (the chat doc's `enrichmentStatus`),
   removing reliance on the in-process `Map` for polling.
3. Until (1) lands, document that the **effective limit = `API_RATE_LIMIT_MAX` ×
   instance count** so operators size it knowingly.

**Risk if flipped blind.** Assuming the in-memory limiter is global silently
**multiplies the abuse/cost ceiling** by the instance count; trusting the
in-memory job map for status returns wrong/empty results on a non-owning instance.

---

## PERF-1 — Keystone Parquet read path is default-OFF; prod rehydrates full rows into a JS array

**Problem.** The columnar Parquet read path
([`../../server/lib/sessionParquet.ts`](../../server/lib/sessionParquet.ts)) is gated
by `USE_PARQUET_READ_PATH` and ships **default-OFF**; production still rehydrates
the full dataset rows into a JS array per request. The one open question gating
the flag — can DuckDB read a blob-stored Parquet remotely via a SAS URL on the
read-only host, or must it download to `/tmp` first — is unresolved.

**Decision.** Keep the flag OFF until the read path is validated on the real host.
Do not enable a default-OFF keystone without host validation.

**Migration path.**
1. Run the spike harness ([`../../server/scripts/spikeParquetReadPath.ts`](../../server/scripts/spikeParquetReadPath.ts))
   on a real deploy/preview where Azure Blob creds are set — it validates remote
   Parquet reads (DuckDB `httpfs`/`azure`) and prints a DECISION line.
2. Wire the **ingest-time writer** to populate `chat.parquetBlob` so the read path
   has a Parquet to read.
3. Enable `USE_PARQUET_READ_PATH` behind the **existing flag** once (1)+(2) hold.

**Risk if flipped blind.** Enabling the flag before host validation can fault
every read on hosts where DuckDB cannot read the remote blob (or where the writer
never populated `parquetBlob`) — i.e. the whole data path breaks in prod.

---

## PERF-2 — Ingest loads the whole dataset into a JS array even on the DuckDB large-file path

**Problem.** Even the large-file ingest path
([`../../server/lib/largeFileProcessor.ts`](../../server/lib/largeFileProcessor.ts)) —
built for ≥50 MB files — round-trips rows through the JS heap (rows → CSV →
`read_csv_auto`) and re-materializes them, so ingestion OOMs at scale despite
DuckDB being available. This is the ingest mirror of PERF-1.

**Decision.** Keep the SQL-native ingest behind the same Parquet staging as
PERF-1; the primitives already exist (`COPY … TO (FORMAT PARQUET)` in
[`../../server/lib/sessionParquet.ts`](../../server/lib/sessionParquet.ts)).

**Migration path.**
1. Apply temporal facets **in DuckDB SQL** rather than in a JS loop over loaded
   rows.
2. Write Parquet **directly** via `COPY (SELECT … ) TO '…' (FORMAT PARQUET)`
   instead of the rows → CSV → `read_csv_auto` round-trip, so ingest never
   materializes the full dataset in the JS heap.

**Risk if flipped blind.** Cutting ingest over without first proving the
SQL-native facet + `COPY` path produces byte-equivalent facets risks **corrupting
or silently dropping derived facet columns** on the ingest of every dataset.

---

## Consequences

- All six findings stay **🟦 STAGED / 🟡 PARTIAL — NOT ✅ DONE** in
  [`docs/expert-audit/REMEDIATION-TRACKER.md`](../expert-audit/REMEDIATION-TRACKER.md)
  (waves EX8 / EX9 / EX10 / EX12). The honesty is the point: each requires **infra
  access, product sign-off, or a live data migration** before it can ship.
- Two of them have a **lower-lift interim** that needs no new infra and is feasible
  today: doc-driven upload status (DATA-2 / PERF-7) reads `enrichmentStatus` off the
  Cosmos doc instead of an in-process `Map`.
- The flag-gated keystones (PERF-1 / PERF-2) are written code-ready and validated by
  the spike harness on the host **before** the flag flips — see invariant on
  default-OFF keystones in [`expert-audit-remediation.md`](./expert-audit-remediation.md).
- This ADR is the design backing for the tracker rows; it is not a sign-off to
  execute. Executing any of these is a deliberate, sequenced wave with its own
  dual-write / backfill / cutover plan and a rollback.
