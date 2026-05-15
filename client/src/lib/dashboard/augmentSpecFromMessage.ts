/**
 * DPF3 · fold message-only fields the user can see in chat into the
 * agent-built `DashboardSpec` BEFORE posting to `/api/dashboards/from-spec`.
 *
 * Why this exists: the agent's auto-create runs synchronously inside the
 * agent loop and DPF2 already populates `followUpPrompts`,
 * `investigationSummary`, and `priorInvestigationsSnapshot` from the same
 * scope the message persist uses. But `businessActions` resolves AFTER the
 * verifier passes, so the auto-create spec never carries them. The chat
 * message — which the user is acting on when they click "Create dashboard" —
 * does carry them (post-verifier patch via `patchAssistantBusinessActions`).
 *
 * Manual-create paths (`DashboardDraftCard`, `BuildDashboardCallout`) call
 * this helper to thread the message-level businessActions and the three
 * sync fields onto the spec at POST time. Spec values win when present —
 * the agent's auto-populated spec is authoritative if it carries the field;
 * we only fill in what's missing.
 *
 * `capturedActiveFilter` is intentionally NOT touched here: the server
 * looks up the live `chatDocument.activeFilter` from `sessionId` at
 * persist time, which is the right behaviour (the chat surface might be
 * filtered now even if the message is from a prior unfiltered turn).
 */

import type { DashboardSpec, Message } from "@/shared/schema";

export function augmentSpecFromMessage(
  spec: DashboardSpec,
  message: Message | undefined
): DashboardSpec {
  if (!message) return spec;
  return {
    ...spec,
    businessActions:
      spec.businessActions ?? message.businessActions ?? undefined,
    followUpPrompts:
      spec.followUpPrompts ?? message.followUpPrompts ?? undefined,
    investigationSummary:
      spec.investigationSummary ?? message.investigationSummary ?? undefined,
    priorInvestigationsSnapshot:
      spec.priorInvestigationsSnapshot ??
      message.priorInvestigationsSnapshot ??
      undefined,
  };
}
