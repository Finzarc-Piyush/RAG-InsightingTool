export function mergeSuggestedQuestions(
  fromContext?: string[],
  fromProfile?: string[],
  limit = 12
): string[] {
  return [...new Set([...(fromContext || []), ...(fromProfile || [])])].slice(0, limit);
}
