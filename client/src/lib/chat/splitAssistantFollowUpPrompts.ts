/**
 * Detects a trailing "**You might try:**" block (legacy markdown) and splits it from the main body.
 * Bullet lines use leading "- " (markdown list).
 */
export function splitAssistantFollowUpPrompts(content: string): {
  mainMarkdown: string;
  extractedPrompts: string[];
  hadYouMightTrySection: boolean;
} {
  const raw = content ?? "";
  const lines = raw.split("\n");

  let headerIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*\*\*you might try:\*\*\s*$/i.test(lines[i])) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    return { mainMarkdown: raw.trimEnd(), extractedPrompts: [], hadYouMightTrySection: false };
  }

  const bulletLines = lines.slice(headerIndex + 1);
  const prompts: string[] = [];
  for (const line of bulletLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = line.match(/^\s*-\s+(.*)$/);
    if (m) {
      const p = m[1].trim();
      if (p) prompts.push(p);
    } else if (prompts.length > 0) {
      break;
    }
  }

  const mainMarkdown = lines.slice(0, headerIndex).join("\n").trimEnd();
  return {
    mainMarkdown,
    extractedPrompts: prompts.slice(0, 3),
    hadYouMightTrySection: true,
  };
}
