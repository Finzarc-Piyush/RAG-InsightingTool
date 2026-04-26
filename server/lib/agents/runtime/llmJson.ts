import { MODEL } from "../../openai.js";
import type { ZodType } from "zod";
import { agentLog } from "./agentLogger.js";
import { callLlm, emitLlmUsage, type LlmCallUsage } from "./callLlm.js";
import { calculateCostUsd, normalizeUsage } from "./llmCostModel.js";
import { resolveModelFor, type LlmCallPurpose } from "./llmCallPurpose.js";

export type { LlmCallUsage } from "./callLlm.js";

export async function completeJson<T>(
  system: string,
  user: string,
  schema: ZodType<T>,
  options: {
    maxTokens?: number;
    temperature?: number;
    /** Defaults to main chat deployment; set INSIGHT_MODEL for a dedicated insights deployment. */
    model?: string;
    turnId?: string;
    onLlmCall?: () => void;
    /** Fires once per API call with token counts + computed USD cost (W1.1 telemetry). */
    onUsage?: (usage: LlmCallUsage) => void;
    /**
     * W3.2 · When set, selects the model via `resolveModelFor(purpose)` and
     * OVERRIDES `options.model`. Migrated call sites pass this and stop caring
     * which deployment to use — ops flip env vars to route.
     */
    purpose?: LlmCallPurpose;
  }
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const maxTokens = options.maxTokens ?? 2048;
  const temperature = options.temperature ?? 0.2;
  // W3.10 · pass turnId to keep the ramp decision stable across retries within
  // the same logical turn. completeJson owns the retry loop (attempt 1..3)
  // and we want every attempt to hit the same side of the MINI/PRIMARY ramp.
  const model = options.purpose
    ? resolveModelFor(options.purpose, { turnId: options.turnId })
    : (options.model ?? MODEL);
  const mark = () => options.onLlmCall?.();

  let attempt = 0;

  const runOnce = async (sys: string, usr: string) => {
    mark();
    attempt += 1;
    const startedAt = Date.now();
    // Bypass `callLlm`'s default single-attempt emit because completeJson owns
    // the retry loop — we need to publish with the correct `attempt` index. We
    // still publish via the same global emitter so the sink (W1.3) sees every
    // retry call.
    const res = await callLlm(
      {
        model: model as string,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: usr },
        ],
        response_format: { type: "json_object" },
        temperature,
        max_tokens: maxTokens,
      },
      {
        // completeJson owns the retry loop — suppress callLlm's default emit
        // and re-emit below with the correct `attempt` index.
        skipGlobalEmit: true,
        turnId: options.turnId,
        // Already resolved the model above; skip redundant purpose routing in callLlm.
      }
    );
    const text = res.choices[0]?.message?.content || "{}";
    const normalized = normalizeUsage(res.usage);
    if (normalized) {
      const usage: LlmCallUsage = {
        ...normalized,
        model: model as string,
        costUsd: calculateCostUsd(model as string, normalized),
        latencyMs: Date.now() - startedAt,
        attempt,
        turnId: options.turnId,
        purpose: options.purpose,
      };
      emitLlmUsage(usage);
      options.onUsage?.(usage);
    }
    return text;
  };

  // Robust JSON.parse that tolerates the "{…}\n\nmore prose" variant LLMs
  // sometimes produce even under response_format=json_object.
  const extractJson = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      // Fall back to first {..} / [..] match.
      const match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (match) {
        return JSON.parse(match[1]);
      }
      throw new Error("No JSON object found in model output");
    }
  };

  try {
    let text = await runOnce(system, user);
    let parsed = schema.safeParse(extractJson(text));
    if (parsed.success) {
      return { ok: true, data: parsed.data };
    }
    agentLog("llm_json_retry", { turnId: options.turnId, err: parsed.error.message });

    // Pass 2: feed back the validation error and the raw output.
    const repairUser = `Your previous output was invalid JSON for the schema. Errors: ${parsed.error.message}\n\nRaw:\n${text}\n\nReturn ONLY corrected JSON.`;
    text = await runOnce(
      system + "\nOutput ONLY valid JSON matching the schema.",
      repairUser
    );
    parsed = schema.safeParse(extractJson(text));
    if (parsed.success) {
      return { ok: true, data: parsed.data };
    }
    agentLog("llm_json_retry2", { turnId: options.turnId, err: parsed.error.message });

    // Pass 3 (P-021): a last, minimal-instruction attempt that strips the
    // prior attempt's context entirely. Often the model just needed a clean slate.
    text = await runOnce(
      "Return ONLY a single JSON object matching the caller's schema. No prose, no explanation.",
      user
    );
    parsed = schema.safeParse(extractJson(text));
    if (parsed.success) {
      return { ok: true, data: parsed.data };
    }
    return { ok: false, error: parsed.error.message };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
