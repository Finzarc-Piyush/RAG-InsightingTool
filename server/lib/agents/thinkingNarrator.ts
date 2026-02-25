/**
 * Thinking Narrator
 * AI-generated labels and streaming narration for the "thinking" display.
 * Avoids hardcoded step text by asking the model to phrase steps in context.
 */
import { openai } from "../openai.js";
import { getModelForTask } from "./models.js";
import { Response } from "express";
import { sendSSE } from "../../utils/sse.helper.js";

/** Known step keys we use in the chat stream (analysis path). */
export const KNOWN_THINKING_STEP_KEYS = [
  "Extracting columns from message",
  "Analyzing user intent",
  "Detecting query type",
  "Planning query against full dataset",
  "Executing query plan on full dataset",
  "Generating explanation from query result",
  "Processing...",
] as const;

export type ThinkingStepKey = (typeof KNOWN_THINKING_STEP_KEYS)[number];

export interface ThinkingStepLabel {
  label: string;
  nextStep?: string;
}

/**
 * Get AI-generated human-readable labels for thinking steps based on the user question.
 * Returns a map from step key to { label, nextStep }. Used so we don't hardcode step text.
 */
export async function getThinkingLabels(
  userQuestion: string,
  stepKeys: readonly string[] = KNOWN_THINKING_STEP_KEYS
): Promise<Record<string, ThinkingStepLabel>> {
  const model = getModelForTask("intent");
  const prompt = `You are a UX copywriter for a data analysis assistant. The user asked: "${userQuestion}"

Given the following internal step names, return a JSON object where each key is exactly one of the step names below, and each value is { "label": string, "nextStep": string }.
- "label": A short, friendly phrase for the UI (e.g. "Identifying which columns you mean" instead of "Extracting columns from message"). Keep it to a few words.
- "nextStep": One short phrase for what happens right after this step (e.g. "I'll then plan the query"). Optional; omit if not needed.

Step names (use these exact keys):
${stepKeys.map((k) => `- ${k}`).join("\n")}

Output only valid JSON. No markdown. Example format:
{"Extracting columns from message":{"label":"Identifying which columns you mean","nextStep":"Understanding your intent"}}`;

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "You output only valid JSON. Use the exact step names as keys. Be concise.",
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 600,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return {};

    const parsed = JSON.parse(content) as Record<string, { label?: string; nextStep?: string }>;
    const result: Record<string, ThinkingStepLabel> = {};
    for (const key of stepKeys) {
      const v = parsed[key];
      if (v && typeof v.label === "string") {
        result[key] = {
          label: v.label,
          nextStep: typeof v.nextStep === "string" ? v.nextStep : undefined,
        };
      }
    }
    return result;
  } catch (err) {
    console.error("Thinking narrator getThinkingLabels failed:", err);
    return {};
  }
}

/**
 * Stream a short, tokenized "what I'm about to do" narration (Cursor-style).
 * Sends only thinking_log_chunk for each token. Caller sends thinking_log_done once at end of full stream.
 */
export async function streamThinkingIntro(
  res: Response,
  userMessage: string,
  checkConnection: () => boolean
): Promise<void> {
  const model = getModelForTask("intent");
  const prompt = `The user asked about their data: "${userMessage.slice(0, 300)}"

In 1–2 short sentences, first person, present tense, say what you're about to do. Examples: "I'll figure out which columns matter, plan a query, run it, and then explain the results." or "Checking your question, then running the analysis and preparing an explanation."
Do not include code. Be concise. No preamble.`;

  try {
    const stream = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "You write one or two short sentences only. First person. No code.",
        },
        { role: "user", content: prompt },
      ],
      stream: true,
      max_tokens: 120,
      temperature: 0.4,
    });

    for await (const chunk of stream) {
      if (checkConnection && !checkConnection()) break;
      const token = chunk.choices[0]?.delta?.content;
      if (token) {
        sendSSE(res, "thinking_log_chunk", { content: token });
      }
    }
    // Do NOT send thinking_log_done here; caller sends it once at end of full thinking stream
  } catch (err) {
    console.error("Thinking narrator streamThinkingIntro failed:", err);
  }
}
