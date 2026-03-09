import type { Message } from "../shared/schema.js";
import { openai, MODEL } from "./openai.js";

export interface GeneralAnswer {
  answer: string;
}

/**
 * Lightweight client for answering open-domain questions that are
 * NOT about the uploaded dataset (world knowledge, facts, etc.).
 * This intentionally avoids passing dataset summaries or rows.
 */
export async function answerGeneralQuestion(
  question: string,
  chatHistory: Message[] = []
): Promise<GeneralAnswer> {
  const trimmed = question?.trim();
  if (!trimmed) {
    return { answer: "Could you please share your question?" };
  }

  const recentHistory = chatHistory
    .slice(-5)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const userPrompt = `USER QUESTION:
"${trimmed}"

${recentHistory ? `RECENT CONVERSATION:\n${recentHistory}\n\n` : ""}IMPORTANT:
- Answer using your general world knowledge.
- If the question clearly refers to the user's uploaded dataset, table, or CSV (for example: mentions specific column names or says "in this dataset"), DO NOT fabricate a data-specific answer. Instead, respond with a short sentence saying that those questions are handled by the data analysis assistant in the app.`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a helpful general-purpose assistant. You answer open-domain questions using world knowledge. Do not make up numbers or statistics about the user's private dataset; those questions are handled by a separate data analysis assistant.",
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],
    temperature: 0.2,
    max_tokens: 400,
  });

  const content = response.choices[0]?.message?.content?.trim();
  return {
    answer:
      content ||
      "I'm not sure how to answer that right now, but I can try again if you rephrase the question.",
  };
}

