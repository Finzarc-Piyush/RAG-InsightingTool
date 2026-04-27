# W28 / W33 · Live-LLM golden-replay fixtures

These fixtures drive `tests/liveLlmGoldenReplayW28.test.ts` against the
real Azure OpenAI / Anthropic provider. The test is double-gated and
**skipped by default** in CI — operators run it manually or on a
nightly schedule.

## Fixtures

| File | Question shape | What it exercises |
|---|---|---|
| `q01-saffola-mt-share.json` | driver_discovery | Baseline analytical turn — implications + recommendations + investigationSummary |
| `q02-channel-mix-comparison.json` | comparison | Comparison shape; envelope still required |
| `q03-trend.json` | trend | Trend shape; minimum body length only |
| `q04-citation-check.json` | driver_discovery + W22 citation gate | Asserts `domainLens` cites a real pack id (regex) |
| `q05-conversational.json` | descriptive | W17 completeness gate should NOT enforce — bypass case |

Each fixture is a single JSON object with these fields:

```jsonc
{
  "id": "q##-name",
  "question": "<user question text>",
  "questionShape": "driver_discovery|comparison|trend|descriptive|...",
  "minBodyChars": 500,
  "minEnvelopeFields": 2,
  "expectInvestigationSummary": true,
  "expectAnswerSourceIn": ["narrator", "synthesizer", "delegate"],

  // Optional — only when relevant:
  "expectDomainLensCitesPackId": true,
  "knownPackIdRegex": "(marico-|fmcg-|...)",
  "expectCompletenessGateBypassed": true
}
```

## Running the replay

### Default mode (assertions only)

```bash
cd server
LIVE_LLM_REPLAY=true \
  AGENTIC_ALLOW_NO_RAG=true \
  AZURE_OPENAI_API_KEY=sk-... \
  AZURE_OPENAI_ENDPOINT=https://...openai.azure.com \
  AZURE_OPENAI_DEPLOYMENT_NAME=gpt-4o \
  node --import tsx --test tests/liveLlmGoldenReplayW28.test.ts
```

Each fixture runs through `runAgentTurn` against the real LLM. Cost
~$0.50–$1.00 per fixture. SHAPE assertions only — never exact text —
so non-determinism doesn't cause flakes.

### Recording mode (W33)

When tightening assertions later, capture what the LLM actually
produces:

```bash
LIVE_LLM_REPLAY=true RECORD_LIVE_LLM_BASELINE=true \
  AGENTIC_ALLOW_NO_RAG=true AZURE_OPENAI_API_KEY=... \
  ... node --import tsx --test tests/liveLlmGoldenReplayW28.test.ts
```

Each run writes `<id>.recorded.json` next to the fixture, containing
the full result envelope (answer, envelope, investigationSummary,
charts sample, agent-trace highlights). Assertions are loosened to
"non-empty answer" so the test passes — operators inspect the
recorded files to decide what tighter assertions to bake in next.

`*.recorded.json` files are gitignored locally; commit only the
fixture JSON, never the recordings.

## When to add a new fixture

- New question shape (e.g. `variance_diagnostic`)
- New gate is added (e.g. a new W17/W22-style verifier check)
- A specific user complaint about output quality is being pinned

Keep fixtures **shape-shaped, not text-shaped** — LLM output drifts;
asserting against schema thresholds keeps the suite stable.
