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
  patchSemanticModel,
  revertSemanticModel,
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

export default router;
