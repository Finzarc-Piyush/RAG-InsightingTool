import { Router } from "express";
import { adminCostsController } from "../controllers/adminCostsController.js";
import {
  listDomainContextPacks,
  setDomainContextPackEnabled,
} from "../controllers/adminDomainContextController.js";

const router = Router();

// W6.4 · admin cost rollup. Gated by ADMIN_EMAILS env allow-list.
router.get("/admin/costs", adminCostsController);

// WD8 · domain-context pack toggles. Gated by ADMIN_EMAILS.
router.get("/admin/domain-context/packs", listDomainContextPacks);
router.patch("/admin/domain-context/packs/:packId", setDomainContextPackEnabled);

export default router;
