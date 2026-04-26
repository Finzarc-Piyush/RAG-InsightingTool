import type { Message } from "@/shared/schema";

/**
 * W7 · serialize an assistant Message to a single markdown block suitable
 * for clipboard. Order mirrors the AnswerCard's visual hierarchy so what
 * the user sees is what they paste.
 *
 * - When `answerEnvelope` is present, we emit a structured layout
 *   (TL;DR → Findings → Methodology → Caveats → Next steps).
 * - When absent, we fall back to the message's existing markdown `content`,
 *   which is already what the bubble was rendering.
 *
 * The serializer is pure (no DOM access) so it can run in tests and in
 * non-browser contexts; clipboard write is the caller's responsibility.
 */
export function answerToMarkdown(message: Message): string {
  const env = message.answerEnvelope;
  if (!env) return (message.content ?? "").trim();

  const lines: string[] = [];

  if (env.tldr) {
    lines.push(`**TL;DR** — ${env.tldr.trim()}`);
    lines.push("");
  }

  if (message.content?.trim() && message.content.trim() !== env.tldr?.trim()) {
    lines.push(message.content.trim());
    lines.push("");
  }

  if (env.findings?.length) {
    lines.push("### Findings");
    env.findings.forEach((f, i) => {
      const mag = f.magnitude ? ` _(${f.magnitude})_` : "";
      lines.push(`${i + 1}. **${f.headline}**${mag}`);
      if (f.evidence) {
        lines.push(`   ${f.evidence}`);
      }
    });
    lines.push("");
  }

  if (env.methodology) {
    lines.push("### Methodology");
    lines.push(env.methodology.trim());
    lines.push("");
  }

  if (env.caveats?.length) {
    lines.push("### Caveats");
    for (const c of env.caveats) lines.push(`- ${c}`);
    lines.push("");
  }

  if (env.nextSteps?.length) {
    lines.push("### Next steps");
    for (const n of env.nextSteps) lines.push(`- ${n}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Copy the rendered answer to the system clipboard. Returns true on success.
 *
 * Falls back to a textarea-select-execCommand path on browsers/contexts where
 * `navigator.clipboard` is unavailable (older Safari, insecure-origin dev, etc.).
 */
export async function copyAnswerToClipboard(message: Message): Promise<boolean> {
  const text = answerToMarkdown(message);
  if (!text) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
