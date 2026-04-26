# W2 · Synthesis routing to Claude Opus 4.7

**Status:** Configured (default OFF — env vars are commented in `.env.example`).

## What changed

- `server/.env.example` documents the recommended per-purpose overrides.
- `server/tests/llmRoutingClaude.test.ts` pins the routing decision so
  classifier/synthesis mappings cannot regress silently.
- No code change in [llmCallPurpose.ts](../../../server/lib/agents/runtime/llmCallPurpose.ts);
  the existing `OPENAI_MODEL_FOR_<PURPOSE>` precedence already supports any model name.
- W1's [callLlm.ts](../../../server/lib/agents/runtime/callLlm.ts) dispatches to the
  Anthropic provider when the resolved name starts with `claude-`.

## Recommended routing

| Purpose            | Default (PRIMARY) | Recommended  | Why                                                 |
|--------------------|-------------------|--------------|-----------------------------------------------------|
| `narrator`         | gpt-4o            | claude-opus-4-7 | Final answer text users read; deepest synthesis     |
| `verifier_deep`    | gpt-4o            | claude-opus-4-7 | Catches narrator hallucinations / coverage gaps     |
| `coordinator`      | gpt-4o            | claude-opus-4-7 | Decomposes the question into sub-questions          |
| `hypothesis`       | gpt-4o            | claude-opus-4-7 | First-step reasoning quality drives all downstream  |
| `planner`          | gpt-4o            | (keep) gpt-4o | JSON-mode 12-step DAG; latency + JSON fidelity matter |
| `reflector`        | gpt-4o            | (keep) gpt-4o | Per-step continue/replan/finish — fast turnaround   |
| `final_answer`     | gpt-4o            | (keep) gpt-4o | Used by the synthesizer fallback path only          |
| `analysis_brief`   | gpt-4o            | (keep) gpt-4o | Mid-tier; not user-visible                          |
| Classifiers / parsers | gpt-4o-mini   | (keep) gpt-4o-mini | Cost-optimized routing (W3 of cost roadmap)      |

## Cost expectations

Claude Opus 4.7 is roughly **6×** the input rate and **7.5×** the output rate
of GPT-4o. We route only the four most reasoning-heavy purposes; the rest stay
on Azure. Per-turn delta typically lands at **+$0.30 to +$1.50** depending on
evidence size and answer length. The existing
[budgetGate.ts](../../../server/middleware/budgetGate.ts) per-user daily cap
applies unchanged — set a conservative `USER_DAILY_BUDGET_USD` before enabling
in shared environments.

## How to enable

In `server/server.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-…
OPENAI_MODEL_FOR_NARRATOR=claude-opus-4-7
OPENAI_MODEL_FOR_VERIFIER_DEEP=claude-opus-4-7
OPENAI_MODEL_FOR_COORDINATOR=claude-opus-4-7
OPENAI_MODEL_FOR_HYPOTHESIS=claude-opus-4-7
```

Restart server; the next chat turn picks up the new routing. No client change
needed.

## How to disable / roll back

Comment out (or unset) the four `OPENAI_MODEL_FOR_*` vars. The router's
fallback chain returns the deployment name from `AZURE_OPENAI_DEPLOYMENT_NAME`
(or hardcoded `gpt-4o`) — no restart required for ramp-style rollouts because
[llmCallPurpose.ts](../../../server/lib/agents/runtime/llmCallPurpose.ts:194)
reads env lazily on each call.

## Verification

```bash
cd server
node --import tsx --test tests/llmRoutingClaude.test.ts
```

End-to-end (with all three services running and the env vars set):

```bash
# Server logs will show: "model=claude-opus-4-7" for narrator calls
tail -f server/server.log | grep narrator
# Cost dashboard /admin/costs will attribute the spend to the narrator purpose.
```
