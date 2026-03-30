import { openai, MODEL } from "../../openai.js";
import type { ZodType } from "zod";
import { agentLog } from "./agentLogger.js";

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
  }
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const maxTokens = options.maxTokens ?? 2048;
  const temperature = options.temperature ?? 0.2;
  const model = options.model ?? MODEL;
  const mark = () => options.onLlmCall?.();

  const runOnce = async (sys: string, usr: string) => {
    mark();
    const res = await openai.chat.completions.create({
      model: model as string,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: usr },
      ],
      response_format: { type: "json_object" },
      temperature,
      max_tokens: maxTokens,
    });
    const text = res.choices[0]?.message?.content || "{}";
    return text;
  };

  try {
    let text = await runOnce(system, user);
    let parsed = schema.safeParse(JSON.parse(text));
    if (parsed.success) {
      return { ok: true, data: parsed.data };
    }
    agentLog("llm_json_retry", { turnId: options.turnId, err: parsed.error.message });
    const repairUser = `Your previous output was invalid JSON for the schema. Errors: ${parsed.error.message}\n\nRaw:\n${text}\n\nReturn ONLY corrected JSON.`;
    text = await runOnce(
      system + "\nOutput ONLY valid JSON matching the schema.",
      repairUser
    );
    parsed = schema.safeParse(JSON.parse(text));
    if (parsed.success) {
      return { ok: true, data: parsed.data };
    }
    return { ok: false, error: parsed.error.message };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
