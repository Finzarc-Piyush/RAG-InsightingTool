/**
 * W9 · regenerate prompt builder.
 *
 * Lives outside the React component so it can be unit-tested under tsx without
 * needing to resolve `@/*` path aliases or import JSX.
 *
 * Convention: when the host re-submits, it MUST send `questionToSubmit`
 * verbatim (don't re-prepend the constraint a second time).
 */

export type RegenerateConstraint =
  | "default"
  | "longer"
  | "shorter"
  | "more_technical"
  | "less_technical";

const CONSTRAINT_PROMPT: Record<Exclude<RegenerateConstraint, "default">, string> = {
  longer: "Give a more thorough, longer answer to:",
  shorter: "Give a tighter, shorter answer to:",
  more_technical: "Give a more technical, deeper-detail answer to:",
  less_technical: "Give a simpler, less technical answer to:",
};

export function buildRegenerateQuestion(
  originalQuestion: string,
  constraint: RegenerateConstraint
): string {
  if (constraint === "default") return originalQuestion;
  return `${CONSTRAINT_PROMPT[constraint]} ${originalQuestion}`;
}

export const REGENERATE_EVENT = "rag:regenerate";

export interface RegenerateEventDetail {
  originalQuestion: string;
  constraint: RegenerateConstraint;
  questionToSubmit: string;
}
