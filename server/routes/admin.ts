import { Router } from "express";
import { adminCostsController } from "../controllers/adminCostsController.js";
import {
  listDomainContextPacks,
  setDomainContextPackEnabled,
} from "../controllers/adminDomainContextController.js";
import {
  listSemanticModels,
  getSemanticModel,
  getSemanticModelAuditLog,
  getSemanticModelReferences,
  patchSemanticModel,
  revertSemanticModel,
  deleteSemanticModelEntry,
  addSemanticModelEntry,
} from "../controllers/adminSemanticModelController.js";

const router = Router();

// W6.4 · admin cost rollup. Gated by ADMIN_EMAILS env allow-list.
router.get("/admin/costs", adminCostsController);

// WD8 · domain-context pack toggles. Gated by ADMIN_EMAILS.
router.get("/admin/domain-context/packs", listDomainContextPacks);
router.patch("/admin/domain-context/packs/:packId", setDomainContextPackEnabled);

// W61-list · semantic-model session index for the admin UI.
router.get("/admin/semantic-models", listSemanticModels);

// W61-detail · per-session semantic-model payload for the read-only viewer.
router.get("/admin/semantic-models/:sessionId", getSemanticModel);

// W61-audit-history-api · per-session prior-model audit ring buffer
// (newest-first; capped at SEMANTIC_MODEL_AUDIT_LOG_MAX_ENTRIES via the
// W61-audit-log append helper). Separate from the detail endpoint to
// avoid bloating its payload with ~500 KB of priorModel snapshots when
// the history is only consulted occasionally.
router.get(
  "/admin/semantic-models/:sessionId/audit-log",
  getSemanticModelAuditLog,
);

// W61-references-endpoint · count how many persisted charts on the
// session reference a given semantic-model entry name. Read-only;
// foundation for the W61-delete-entry confirmation prompt's
// "removing this metric will break N charts" copy. Walks
// `doc.charts[]` only (blob-stored charts via `chartReferences[]`
// are NOT fetched — a future enhancement can add that mode).
router.get(
  "/admin/semantic-models/:sessionId/references",
  getSemanticModelReferences,
);

// W61-save · replace the session's semantic model. Bumps version + stamps updatedAt/updatedBy.
router.patch("/admin/semantic-models/:sessionId", patchSemanticModel);

// W61-audit-revert · one-call restore of a prior model from the audit
// ring buffer. Body: { auditEntryIndex }. The about-to-be-replaced
// model is appended to the audit log as the new newest entry so
// "undo this revert" works without losing the intermediate state.
router.post(
  "/admin/semantic-models/:sessionId/revert",
  revertSemanticModel,
);

// W61-delete-server · remove a single metric / dimension / hierarchy
// from a session's semantic model. Path-param `:kind` is
// `metric` | `dimension` | `hierarchy`; `:name` is the entry's `name`
// field (URL-decoded by Express). Mirrors W61-audit-revert: writes
// the prior model to the audit log inside `withSessionWriteLock`
// before the destructive op so "undo this delete via revert" works,
// bumps version monotonically (W64 cache key invalidation), returns
// the same { sessionId, lastUpdatedAt, model } envelope as W61-save
// so the client mutation reuses the existing success handler.
router.delete(
  "/admin/semantic-models/:sessionId/entries/:kind/:name",
  deleteSemanticModelEntry,
);

// W61-add-server · append a single metric / dimension / hierarchy
// to a session's semantic model. Body is a single entry validated by
// the kind-appropriate zod schema (semanticMetricSchema /
// semanticDimensionSchema / semanticHierarchySchema). Rejects
// same-kind name collisions with 409 Conflict (cross-kind name
// collisions allowed — metric "x" + dimension "x" is fine). Mirrors
// W61-delete-server's audit-write-before-mutation shape; returns the
// same envelope as save/revert/delete so the client success handler
// is identical across all four edit operations.
router.post(
  "/admin/semantic-models/:sessionId/entries/:kind",
  addSemanticModelEntry,
);

export default router;
