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
    lastAnalyticalMeta?: {
      inputRowCount: number;
      outputRowCount: number;
      appliedAggregation: boolean;
    };
    /** P-A3: columns observed in prior successful tool calls — helps the
     *  reflector choose replan vs continue based on what has actually been
     *  explored. */
    workingMemorySuggestedColumns?: string[];
  },
  turnId: string,
  onLlmCall: () => void,
  interAgentDigest?: string
) {
  const system = `You are the reflector for a data agent. Decide the next strategic action.
Output JSON only: {"action":"continue"|"replan"|"finish"|"clarify","note":string optional,"clarify_message":string optional}
- continue: more planned steps should run
- finish: we have enough to answer the user
- replan: the plan is wrong (rare)
- clarify: need user input (set clarify_message)
If observations contain lines including [SYSTEM_VALIDATION], treat them as high-priority signals: prefer **continue** (if more steps can fix it) or **replan** (adjust dateAggregationPeriod, groupBy, filters, use derive_dimension_bucket, or add_computed_columns then re-aggregate) over **finish** when the mismatch would produce a misleading answer.
Use Last analytical metadata when present: if run_analytical_query failed (ok=false) or appliedAggregation is false with output row count nearly equal to input row count, prefer continue or replan over finish until an aggregated result or a clear row-level answer exists. If outputRows=0 but inputRows is large, prefer replan (retry with dimensionFilters / case_insensitive / fewer dimensions) over finish or clarify — observations often include distinct value samples to fix filters. If a chart would help comparisons and none was produced yet, prefer continue.
If "Columns explored so far" is present and the question asks about a dimension NOT in that list, prefer **replan** with a step that explicitly groups by or filters on the missing dimension.`;

  const appendix = appendixForReflectorPrompt(ctx);
  const digestBlock =
    interAgentDigest?.trim().length ?
      `Coordinator handoff log (this turn):\n${interAgentDigest.trim().slice(0, 4000)}\n\n`
      : "";
  const metaLine =
    payload.lastAnalyticalMeta ?
      `Last analytical metadata: inputRows=${payload.lastAnalyticalMeta.inputRowCount}, outputRows=${payload.lastAnalyticalMeta.outputRowCount}, appliedAggregation=${payload.lastAnalyticalMeta.appliedAggregation}\n`
      : "";
  const columnsLine =
    payload.workingMemorySuggestedColumns && payload.workingMemorySuggestedColumns.length > 0
      ? `Columns explored so far (from prior tool suggestedColumns): ${payload.workingMemorySuggestedColumns.slice(0, 20).join(", ")}\n`
      : "";
  const head = `Question: ${ctx.question}${appendix}\n${digestBlock}${metaLine}${columnsLine}Last tool: ${payload.lastTool} ok=${payload.lastOk}\nObservations:\n`;
  // P-A3: bump observation cap so the reflector can reason on real error/summary text.
  const obsMax = Math.max(0, 12000 - head.length);
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
