import { z } from "zod";
import type { AgentConfig } from "./types.js";
import type { AgentExecutionContext } from "./types.js";
import { agentLog } from "./agentLogger.js";

export interface ToolRunContext {
  exec: AgentExecutionContext;
  config: AgentConfig;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  charts?: import("../../../shared/schema.js").ChartSpec[];
  insights?: import("../../../shared/schema.js").Insight[];
  /** For deterministic numeric verify */
  numericPayload?: string;
  table?: any;
  operationResult?: any;
  clarify?: string;
  /** Full assistant text when a delegate tool ran the legacy orchestrator */
  answerFragment?: string;
  /** Column names suggested from retrieve_semantic_context (for planner chaining) */
  suggestedColumns?: string[];
  /** Short structured facts for working-memory / chained planning */
  memorySlots?: Record<string, string>;
}

export type ToolExecutor = (
  ctx: ToolRunContext,
  args: Record<string, unknown>
) => Promise<ToolResult>;

export class ToolRegistry {
  private readonly tools = new Map<
    string,
    { input: z.ZodType<Record<string, unknown>>; run: ToolExecutor }
  >();

  register(name: string, input: z.ZodType<Record<string, unknown>>, run: ToolExecutor) {
    this.tools.set(name, { input, run });
  }

  listToolDescriptions(): string {
    return Array.from(this.tools.keys()).join(", ");
  }

  async execute(
    name: string,
    rawArgs: Record<string, unknown>,
    ctx: ToolRunContext
  ): Promise<ToolResult> {
    const t = this.tools.get(name);
    if (!t) {
      return { ok: false, summary: `Unknown tool: ${name}` };
    }
    const parsed = t.input.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        summary: `Invalid args for ${name}: ${parsed.error.message}`,
      };
    }
    const started = Date.now();
    try {
      const out = await t.run(ctx, parsed.data);
      agentLog("tool_done", {
        tool: name,
        ms: Date.now() - started,
        ok: out.ok,
      });
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      agentLog("tool_error", { tool: name, ms: Date.now() - started });
      return { ok: false, summary: msg };
    }
  }
}
