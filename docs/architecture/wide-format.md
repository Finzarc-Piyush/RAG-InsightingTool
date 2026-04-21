# Wide-format dataset ingest

## Purpose

Let users upload wide-format exports (Nielsen retail panel, Kantar,
other syndicated sources) and analyse them with the same chat +
charts + dashboard surface that works on tidy long-form data. The
whole subsystem exists inside the ingest step; everything
downstream of preview persistence continues to assume tidy data.

## Architectural decision

**Strategy A — detect + reshape at ingest.** One melt pass after
preview persistence, before enrichment. The analytical surface
(query planner, chart compiler, pivot grid, filters, skills) stays
unchanged. Raw wide file lives in blob storage for verification;
the derived long form is what the agents see.

**Not Strategy B** — teaching every downstream agent about wide
format. That would touch `chartSpecCompiler`, `queryPlanExecutor`,
`pivotQueryService`, every skill, every filter; effectively a
rewrite of the analytical runtime.

**Load-bearing constraint**: silent misclassification produces
answers that look right but are wrong. A user-confirmation gate is
mandatory. The classifier proposes, the user confirms or
overrides, the reshape only runs after a decision.

## Key files (in scope)

The list grows wave by wave. As of W0 the subsystem is the doc
itself; each wave below adds the files it introduces.

- (W1) `server/lib/wideFormat/periodVocabulary.ts`
- (W2) `server/lib/wideFormat/metricVocabulary.ts`
- (W3) `server/lib/wideFormat/tokenize.ts`
- (W4) `server/lib/wideFormat/tagColumn.ts`
- (W5) `server/lib/wideFormat/classify.ts`
- (W6) `server/tests/fixtures/wideFormat/*.csv`
- (W7–W8) `server/shared/schema.ts` additions (`WideFormatProposal`,
  `ChatDocument.wideFormatProposal`, `wideFormatDecision`)
- (W9–W10) `python-service/data_operations.py` `melt_frame` +
  `main.py` `/data-ops/melt` route
- (W11) `server/lib/dataOps/melt.ts`
- (W12) `WIDE_FORMAT_ENABLED` flag in
  `server/lib/agents/runtime/assertAgenticRag.ts`
- (W13) SSE event `wide_format_proposal_ready`
- (W14) classifier wired into `server/utils/uploadQueue.ts`
- (W15) enrichment gate in the same file
- (W16–W18) `server/controllers/wideFormatDecisionController.ts`
- (W19–W21) `client/src/pages/Home/Components/WideFormatConfirmModal.tsx`
  + wiring
- (W22–W23) enrichment awareness in `server/lib/datasetProfile.ts`
- (W24–W25) preview toggle (server endpoint + client radio)
- (W26) multi-row header flatten in `server/lib/fileParser.ts`
- (W27) totals-row detection
- (W28) melt size guard
- (W29) `scripts/wideFormatEval.mjs`

## Data contracts

Defined in W7/W8 (`server/shared/schema.ts` + client mirror):

```ts
type WideFormatProposal = {
  format: "long" | "wide" | "ambiguous";
  idVars: string[];
  valueVars: Array<{ column: string; period: string; metric: string }>;
  inferredPeriodType: "week" | "month" | "quarter" | "year" | "period" | "mixed";
  confidence: number; // 0..1
  evidence: string[];
};

type WideFormatDecision = "pending" | "reshape" | "keep_wide" | "manual";
```

After a `reshape` decision, the dataset on disk is long-form with
three new synthetic columns:

- `_period` — ISO-ish canonical period label (`2024-W12`, `2024-03`,
  `2024-Q2`)
- `_metric` — canonical metric name (`Value Sales`, `Volume Share`, …)
- `value` — the numeric value

The original id columns (`Brand`, `Market`, `Category`, etc.) are
preserved untouched.

## Runtime flow

1. Upload arrives at `server/utils/uploadQueue.ts` `processUploadJob`.
2. Preview persists (wide rows, unchanged). `enrichmentStatus: "pending"`.
3. (W14) `classify(columns, sampleRows)` runs. If `format === "wide"` and
   `confidence >= proposalThreshold`:
   - `wideFormatProposal` persisted to the chat document.
   - `wideFormatDecision: "pending"`.
   - SSE emits `wide_format_proposal_ready`.
4. (W15) Enrichment is deferred until `wideFormatDecision !== "pending"`.
5. (W21) Client opens `WideFormatConfirmModal`, user chooses:
   - **reshape** → W16 runs the Python melt, replaces data, rebuilds
     summary, sets `wideFormatDecision: "reshape"`, enrichment proceeds.
   - **keep_wide** → W17 sets `wideKept: true`, enrichment proceeds
     on the wide data with a caveat.
   - **manual** → W18 accepts user-supplied idVars/valueVars and
     feeds them into the melt.
6. Enrichment + session-context seeding proceed as today, with (W22)
   `wideFormatContext` included in the LLM profile payload when the
   data was reshaped.

## Wave index

See `docs/plans/` or `git log` for the full plan. Summary:

| Phase | Waves | What lands |
|---|---|---|
| P0 | W0, W0.5 | Foundation docs + tiny-waves policy in CLAUDE.md |
| P1 | W1–W6 | Pure fn classifier + golden fixtures |
| P2 | W7–W8 | Schema mirror |
| P3 | W9–W11 | Python `melt_frame` + TS shim |
| P4 | W12–W13 | Feature flag + SSE event |
| P5 | W14–W15 | Ingest wiring + enrichment gate |
| P6 | W16–W18 | Decision endpoint (reshape / keep_wide / manual) |
| P7 | W19–W21 | Confirmation modal + wire |
| P8 | W22–W23 | Enrichment LLM awareness |
| P9 | W24–W29 | Preview toggle + edge cases + size guard + eval |

Minimum critical path to working end-to-end: 17 waves.

## Extension points

- **New period pattern** → add a matcher to `periodVocabulary.ts`
  (W1) and a golden test.
- **New metric name** → extend `metricVocabulary.ts` (W2).
- **New source family (Kantar, Circana/IRI)** → extend both
  vocabularies; a new fixture file under `server/tests/fixtures/wideFormat/`
  proves coverage.
- **Custom idVars heuristic** (e.g. user-supplied metadata)** → plug
  into `tagColumn.ts` (W4) before it falls back to pattern matching.

## Known pitfalls

- **Silent misclassification is worse than no feature.** The
  confirmation gate (W21) is not polish; shipping W14 without it
  would reshape datasets the user didn't consent to.
- **Memory inflation.** A 500 × 200 wide file becomes ~500 × (N−ID) ≈
  95 k long rows. The size guard (W28) refuses melt above 2 M
  output rows and returns a clear user message.
- **Flag interactions.** `WIDE_FORMAT_ENABLED` (W12) pairs with
  `AGENTIC_LOOP_ENABLED`, `DEEP_ANALYSIS_SKILLS_ENABLED`, and
  `DASHBOARD_AUTOGEN_ENABLED`. Document the matrix in
  `docs/architecture/ci-and-env.md` as W12 lands.
- **The classifier is heuristic.** No LLM inside `classify`. If a
  file is ambiguous, the classifier says `format: "ambiguous"` and
  the modal opens in the manual tab. Don't push LLM calls into the
  classifier; that's a future wave with its own verification.

## Recent changes

- **W0** — subsystem doc seeded. Purpose, architectural decision,
  key-files roadmap, data contract preview, runtime flow, wave
  index, pitfalls. Zero code change.
