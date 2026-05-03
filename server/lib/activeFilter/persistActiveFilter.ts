/**
 * Wave-FA4 · Server-side helper to write `activeFilter` onto a session doc.
 *
 * Used both by the natural-language `'filter'` data-op intent (which is
 * rerouted away from `saveModifiedData`) and by any future agent tool that
 * wants to set a filter without going through the HTTP controller. Mirrors
 * the controller's mutex-style ordering by relying on a single
 * `updateChatDocument` write.
 */
import type { ChatDocument } from "../../models/chat.model.js";
import { updateChatDocument } from "../../models/chat.model.js";
import type {
  ActiveFilterCondition,
  ActiveFilterSpec,
} from "../../shared/schema.js";
import { invalidateFilteredDataView } from "./resolveSessionDataTable.js";

export async function applyActiveFilterFromIntent(
  doc: ChatDocument,
  conditions: ActiveFilterCondition[]
): Promise<ActiveFilterSpec> {
  const priorVersion = doc.activeFilter?.version ?? 0;
  const next: ActiveFilterSpec = {
    conditions,
    version: priorVersion + 1,
    updatedAt: Date.now(),
  };
  doc.activeFilter = next;
  doc.lastUpdatedAt = Date.now();
  await updateChatDocument(doc);
  invalidateFilteredDataView(doc.sessionId);
  return next;
}

export async function clearActiveFilter(doc: ChatDocument): Promise<void> {
  if (!doc.activeFilter) return;
  delete doc.activeFilter;
  doc.lastUpdatedAt = Date.now();
  await updateChatDocument(doc);
  invalidateFilteredDataView(doc.sessionId);
}
