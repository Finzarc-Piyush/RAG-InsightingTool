/**
 * ============================================================================
 * patchDashboardTool.ts — edit an existing dashboard (the `patch_dashboard` tool)
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Registers the `patch_dashboard` tool the AI agent calls to make a follow-up
 *   edit to a dashboard the user already built. A "patch" is a small set of
 *   changes: add chart(s), remove chart(s), or rename a sheet (a sheet is one
 *   tab/page of a dashboard). Typical prompts: "add a margin chart to the
 *   dashboard we just built", "rename the Evidence sheet to Drivers", "remove
 *   the first two charts". If the user doesn't say which dashboard, the tool
 *   falls back to the last dashboard created in this chat session.
 *
 * WHY IT MATTERS
 *   Lets the user iterate on a dashboard conversationally instead of rebuilding
 *   it from scratch. It validates the request, checks the user is authenticated
 *   and that a target dashboard can be resolved, then applies the change to
 *   persistent storage.
 *
 * KEY PIECES
 *   - patchDashboardToolArgsSchema — the DashboardPatch shape (addCharts /
 *     removeCharts / renameSheet) plus an optional `dashboardId`.
 *   - summarisePatch — turns the requested operations into a short human label.
 *   - registerPatchDashboardTool — registers the tool; resolves the dashboard
 *     id (explicit arg, else the session's last-created dashboard), applies the
 *     patch, and records a best-effort memory-journal entry of the edit.
 *
 * HOW IT CONNECTS
 *   Called by the agent act loop via the tool registry (toolRegistry.ts). The
 *   id fallback reads `ctx.exec.chatDocument.lastCreatedDashboardId`, stamped
 *   by /api/dashboards/from-spec when the user accepts a chat preview card (see
 *   `setLastCreatedDashboardForSession` in chat.model.ts). The actual write is
 *   `patchDashboard` from models/dashboard.model.js (imported lazily inside the
 *   handler to keep startup light); the journal entry goes through
 *   memoryLifecycleBuilders.js. `chartSpecSchema` is re-exported for
 *   registerTools.ts.
 */

import { z } from "zod";

import type { ToolRegistry, ToolRunContext } from "../toolRegistry.js";
import { dashboardPatchSchema } from "../../../../shared/schema.js";
import { chartSpecSchema } from "../../../../shared/schema.js";
import { logger } from "../../../logger.js";
import { errorMessage } from "../../../../utils/errorMessage.js";

// Compose the args locally so the tool can accept `dashboardId`
// alongside the core patch fields.
const patchDashboardToolArgsSchema = dashboardPatchSchema.extend({
  dashboardId: z.string().max(200).optional(),
});

type PatchDashboardToolArgs = z.infer<typeof patchDashboardToolArgsSchema>;

function summarisePatch(args: PatchDashboardToolArgs): string {
  const parts: string[] = [];
  if (args.addCharts?.length) {
    parts.push(`add ${args.addCharts.length} chart(s)`);
  }
  if (args.removeCharts?.length) {
    parts.push(`remove ${args.removeCharts.length} chart(s)`);
  }
  if (args.renameSheet) {
    parts.push(`rename sheet → "${args.renameSheet.name.slice(0, 60)}"`);
  }
  return parts.length > 0 ? parts.join("; ") : "no-op";
}

export function registerPatchDashboardTool(registry: ToolRegistry): void {
  registry.register(
    "patch_dashboard",
    patchDashboardToolArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx: ToolRunContext, rawArgs: Record<string, unknown>) => {
      const parsed = patchDashboardToolArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for patch_dashboard: ${parsed.error.message}`,
        };
      }
      const args = parsed.data;

      const username = ctx.exec.username;
      if (!username) {
        return {
          ok: false,
          summary:
            "patch_dashboard: no authenticated user on this turn; cannot edit a dashboard.",
        };
      }

      const dashboardId =
        args.dashboardId?.trim() ||
        ctx.exec.chatDocument?.lastCreatedDashboardId ||
        undefined;
      if (!dashboardId) {
        return {
          ok: false,
          summary:
            "patch_dashboard: no dashboardId provided and this session has no recently-created dashboard. Create a dashboard first or pass `dashboardId`.",
        };
      }

      const hasAnyOp =
        (args.addCharts?.length ?? 0) > 0 ||
        (args.removeCharts?.length ?? 0) > 0 ||
        !!args.renameSheet;
      if (!hasAnyOp) {
        return {
          ok: false,
          summary:
            "patch_dashboard: nothing to do — at least one of addCharts / removeCharts / renameSheet must be non-empty.",
        };
      }

      try {
        // Model import inside the handler keeps the tool registration
        // file small and avoids a synchronous dep on the dashboards
        // Cosmos container at process start.
        const { patchDashboard } = await import(
          "../../../../models/dashboard.model.js"
        );
        const dashboard = await patchDashboard(dashboardId, username, {
          addCharts: args.addCharts,
          removeCharts: args.removeCharts,
          renameSheet: args.renameSheet,
        });

        // Memory journal: record the dashboard edit so resume-after-days
        // shows the timeline of dashboard evolution. Best-effort.
        void (async () => {
          try {
            const { buildDashboardPatchedEntry, scheduleLifecycleMemory } =
              await import("../memoryLifecycleBuilders.js");
            scheduleLifecycleMemory(
              buildDashboardPatchedEntry({
                sessionId: ctx.exec.sessionId,
                username,
                dashboardId: dashboard.id,
                dashboardName: dashboard.name ?? dashboard.id,
                addedCount: args.addCharts?.length ?? 0,
                removedCount: args.removeCharts?.length ?? 0,
                renamedSheetTo: args.renameSheet?.name,
                createdAt: Date.now(),
                turnId: ctx.turnId,
              })
            );
          } catch (e) {
            logger.warn(
              "⚠️ analysisMemory dashboard_patched hook failed:",
              e
            );
          }
        })();

        return {
          ok: true,
          summary: `patch_dashboard applied to ${dashboard.id} — ${summarisePatch(args)}.`,
          memorySlots: {
            patched_dashboard_id: dashboard.id,
          },
        };
      } catch (err) {
        const msg = errorMessage(err);
        return {
          ok: false,
          summary: `patch_dashboard failed: ${msg.slice(0, 400)}`,
        };
      }
    },
    {
      description:
        "Apply a follow-up edit to an existing dashboard (add / remove charts, rename sheet). Use this when the user says 'add X to the dashboard' or 'rename that sheet' AFTER a dashboard was created or identified. If dashboardId is omitted the tool falls back to the last-created dashboard from this session.",
      argsHelp:
        '{"dashboardId"?: string, "addCharts"?: [{"chart": ChartSpec, "sheetId"?: string}, ...] (max 8), "removeCharts"?: [{"sheetId": string, "chartIndex": number}, ...] (max 20), "renameSheet"?: {"sheetId": string, "name": string}}',
    }
  );
}

// Re-exported so registerTools.ts does not need its own z/chartSpecSchema imports.
export { chartSpecSchema };
