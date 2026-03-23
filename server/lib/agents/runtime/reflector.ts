import type { AgentExecutionContext } from "./types.js";
import { reflectorOutputSchema } from "./schemas.js";
import { completeJson } from "./llmJson.js";
import { appendixForReflectorPrompt } from "./context.js";

export async function runReflector(
  ctx: AgentExecutionContext,
  payload: {
    observations: string[];
    lastTool: string;
    lastOk: boolean;
  },
  turnId: string,
  onLlmCall: () => void
) {
  const system = `You are the reflector for a data agent. Decide the next strategic action.
Output JSON only: {"action":"continue"|"replan"|"finish"|"clarify","note":string optional,"clarify_message":string optional}
- continue: more planned steps should run
- finish: we have enough to answer the user
- replan: the plan is wrong (rare)
- clarify: need user input (set clarify_message)`;

  const appendix = appendixForReflectorPrompt(ctx);
  const head = `Question: ${ctx.question}${appendix}\nLast tool: ${payload.lastTool} ok=${payload.lastOk}\nObservations:\n`;
  const obsMax = Math.max(0, 6000 - head.length);
  const user = `${head}${payload.observations.join("\n---\n").slice(0, obsMax)}`;

  const out = await completeJson(system, user, reflectorOutputSchema, {
    turnId,
    temperature: 0.2,
    onLlmCall,
  });
  if (!out.ok) {
    return { action: "continue" as const, note: "reflector_parse_failed" };
  }
  return out.data;
}
