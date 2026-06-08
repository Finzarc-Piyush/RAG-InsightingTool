# LLM deployment health — `gpt-5.4-mini` is the common root of slow/flaky turns

> Operational note (config action is yours; code mitigations are shipped). Surfaced
> while debugging "slow startup" + "no response" on the Supervisor Report dataset.

## Symptom

The configured Azure chat deployment (`gpt-5.4-mini`, see startup log
`Chat Deployment: gpt-5.4-mini`) is **slow and unreliable at strict JSON**, which
shows up as:

- `⚠️ inferDatasetProfile: timeout after …ms` — the dataset-profile call exceeded
  its timeout (a healthy model returns in a few seconds), stalling the upload.
- Repeated `agent.llm_json_retry` / `…_retry2` — the model returns JSON that
  doesn't match the strict schemas (e.g. `notes` as an array, `currencyOverrides`
  as an object, `userIntent` missing), forcing full retry round-trips.
- Occasional degraded output (thin narrator answers; the planner inventing a
  non-existent `adherence_rate` column).

Each retry/timeout is a **full LLM round-trip**, so a slow deployment multiplies
turn latency. This is the single highest-leverage thing to fix for overall speed
and reliability.

## Action (yours — Azure config)

1. Verify what `gpt-5.4-mini` actually maps to in the Azure OpenAI resource
   (`rag-marico-openai`). The name is non-standard — confirm it points to a
   current, capable model (a GPT-4-class deployment) and not a throttled/preview
   one.
2. Check the deployment's **TPM/RPM quota and p50/p95 latency** in the Azure
   portal. Sustained multi-second-to-45s latencies indicate under-provisioned
   capacity or a slow model — raise the quota or switch the deployment.
3. Per-role overrides exist if you want a fast model for the hot, structured calls
   (planner / dataset-profile / quick-lookup) — see
   [`llmCallPurpose.ts`](../server/lib/agents/runtime/llmCallPurpose.ts) and the
   `OPENAI_MODEL_FOR_*` env vars (invariant #10). Anthropic Opus routing is opt-in
   per role via those vars + `ANTHROPIC_API_KEY`.
4. Tunable timeout: `DATASET_PROFILE_TIMEOUT_MS` (default now **15000**, lowered
   from 45000) caps how long the upload waits on the profile call before falling
   back to the deterministic profile.

## Code mitigations already shipped (this branch)

- **Profile timeout** lowered 45s → 15s (env-tunable) so a hung deployment can't
  stall "ready to chat" — [`datasetProfile.ts`](../server/lib/datasetProfile.ts).
- **Schema tolerance**: `datasetProfileSchema` now coerces the two most common
  shape-drift cases (`notes` array→string, `currencyOverrides` object→array), so
  those no longer cost a retry round-trip — [`shared/schema.ts`](../server/shared/schema.ts).
- **SSE `tool_call` fix**: the quick-lookup path now emits the required `name`
  field, clearing the `tool_call` schema-validation warning and the "Tool: tool"
  workbench label — [`quickAnswerPath.ts`](../server/lib/agents/runtime/quickAnswerPath.ts).

These reduce the blast radius of a slow/flaky deployment but do **not** replace
the config fix — a healthy, fast deployment is what restores the ~20s turn budget.
