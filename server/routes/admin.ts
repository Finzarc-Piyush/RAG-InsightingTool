import { Router } from "express";
import { adminCostsController } from "../controllers/adminCostsController.js";
import {
  listDomainContextPacks,
  setDomainContextPackEnabled,
} from "../controllers/adminDomainContextController.js";
import {
  listSemanticModels,
  getSemanticModel,
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

export default router;
