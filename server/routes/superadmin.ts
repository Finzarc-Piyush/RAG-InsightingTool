/**
 * Superadmin (shadow viewer) routes — mounted at /api/superadmin/*.
 *
 * Every endpoint except /me also requires superadmin via `requireSuperadmin`.
 * The /me endpoint always returns 200 (with `isSuperadmin: false` for
 * non-allowlist users) so the client can decide whether to render the
 * navbar item without handling 403 specially.
 */

import { Router } from "express";
import {
  superadminMeEndpoint,
  requireSuperadmin,
  listAllSessionsForSuperadminEndpoint,
  getSessionForSuperadminEndpoint,
  listAllDashboardsForSuperadminEndpoint,
  getDashboardForSuperadminEndpoint,
} from "../controllers/superadminController.js";

const router = Router();

router.get("/superadmin/me", superadminMeEndpoint);
router.get(
  "/superadmin/sessions",
  requireSuperadmin,
  listAllSessionsForSuperadminEndpoint
);
router.get(
  "/superadmin/sessions/:sessionId",
  requireSuperadmin,
  getSessionForSuperadminEndpoint
);
router.get(
  "/superadmin/dashboards",
  requireSuperadmin,
  listAllDashboardsForSuperadminEndpoint
);
router.get(
  "/superadmin/dashboards/:dashboardId",
  requireSuperadmin,
  getDashboardForSuperadminEndpoint
);

export { requireSuperadmin };

export default router;
