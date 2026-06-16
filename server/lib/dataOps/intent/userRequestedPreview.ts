/**
 * `userRequestedPreview` intent helper — extracted verbatim from
 * `dataOpsOrchestrator.ts` (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Pure predicate over the raw user message, zero coupling to the orchestrator's
 * locals / session state. Detects an explicit "show me the data / preview"
 * request so a non-modifying op can opt into returning a preview. Behaviour-
 * preserving move.
 */

export function userRequestedPreview(message: string | undefined): boolean {
  if (!message) return false;
  const lowerMessage = message.toLowerCase();

  // Check for explicit preview/show requests
  const previewPatterns = [
    /show\s+(?:me\s+)?(?:the\s+)?(?:data|dataset|result|updated\s+data|new\s+data)/i,
    /preview/i,
    /display/i,
    /see\s+(?:the\s+)?(?:data|dataset|result)/i,
    /view\s+(?:the\s+)?(?:data|dataset)/i,
    /give\s+me\s+(?:a\s+)?(?:preview|look)/i,
  ];

  return previewPatterns.some(pattern => pattern.test(lowerMessage));
}
