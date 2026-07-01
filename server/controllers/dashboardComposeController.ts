/**
 * Wave W5 (data-bound cards) · the compose/preview endpoints — the first
 * dashboard routes that run a LIVE measure×agg×filter query against the
 * dataset behind `dashboard.sessionId`. `/tiles/preview` computes without
 * persisting (the builder's live preview); `/tiles/compose` computes AND
 * persists the tile (definition + snapshot) so it recomputes on refresh.
 *
 * Both enforce the aggregation guardrail server-side (you can't SUM a
 * percentage → 422). Flag-gated by DASHBOARD_CARD_BUILDER_ENABLED.
 */

import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";
import {
  dashboardCardDefinitionSchema,
  type ChartSpec,
  type DashboardTableSpec,
  type DashboardScorecardSpec,
  type DataSummary,
  type SemanticModel,
} from "../shared/schema.js";
import type { ChatDocument } from "../models/chat.model.js";
import {
  getDashboardById,
  addChartToDashboard,
  addTableToDashboard,
  addScorecardToDashboard,
  patchDashboard,
} from "../models/dashboard.model.js";
import {
  compileCardSpecToPlan,
  runComposePlan,
  deriveScorecardFormat,
  buildBuilderMetadata,
} from "../lib/dashboardTileCompose.js";
import { computeScorecard } from "../lib/scorecard/computeScorecard.js";
import { buildChartFromAnalyticalTable } from "../lib/agents/runtime/chartFromTable.js";
import { resolveMetricPolarity } from "../lib/financeMetricAuthority.js";
import { isFlagOn } from "../lib/featureFlags.js";
import { logger } from "../lib/logger.js";
import { errorMessage } from "../utils/errorMessage.js";

const composeRequestSchema = z.object({
  cardDefinition: dashboardCardDefinitionSchema,
  sheetId: z.string().max(120).optional(),
  title: z.string().min(1).max(160).optional(),
});

type ArtifactResult =
  | { ok: true; cardType: "scorecard"; scorecard: DashboardScorecardSpec }
  | { ok: true; cardType: "chart"; chart: ChartSpec }
  | { ok: true; cardType: "table"; table: DashboardTableSpec }
  | { ok: false; status: number; error: string; allowed?: string[] };

/**
 * Compile → execute → shape a tile artifact from a card definition. Shared by
 * preview (no persist) and compose (persist). Never persists here. `loadRows`
 * is injectable (defaults to the chat's data loader) so it's unit-testable
 * without touching storage.
 */
export async function buildTileArtifact(
  def: z.infer<typeof dashboardCardDefinitionSchema>,
  ctx: {
    sessionId: string;
    chat: ChatDocument;
    title?: string;
    loadRows?: () => Promise<Record<string, any>[]>;
  }
): Promise<ArtifactResult> {
  const summary = ctx.chat.dataSummary;
  const model: SemanticModel | undefined = ctx.chat.semanticModel;

  const compiled = compileCardSpecToPlan(def, summary, model);
  if (!compiled.ok) {
    // Guardrail: a sum-on-ratio (or other illegal aggregation) is a 422.
    return { ok: false, status: 422, error: compiled.error, allowed: compiled.allowed };
  }

  const title = ctx.title?.trim() || `${def.measure.label} (${def.aggregation})`;
  const loadRows = ctx.loadRows ?? (() => loadRowsForChat(ctx.chat));

  if (def.cardType === "scorecard") {
    const fmt = deriveScorecardFormat(def.measure.ref, summary);
    const spec: DashboardScorecardSpec = {
      id: `sc_${randomUUID().slice(0, 8)}`,
      title,
      cardDefinition: def,
      format: fmt.format,
      ...(fmt.currencyCode ? { currencyCode: fmt.currencyCode } : {}),
      metricPolarity: resolveMetricPolarity(def.measure.ref),
    };
    const snapshot = await computeScorecard(spec, {
      summary,
      sessionId: ctx.sessionId,
      chat: ctx.chat,
      model,
      loadRows,
      dataVersion: (ctx.chat as { currentDataVersion?: number }).currentDataVersion,
    });
    return { ok: true, cardType: "scorecard", scorecard: { ...spec, snapshot } };
  }

  // chart / table need executed rows.
  const res = await runComposePlan({
    sessionId: ctx.sessionId,
    chat: ctx.chat,
    summary,
    plan: compiled.plan,
    loadRows,
  });
  if (!res.ok) return { ok: false, status: 400, error: res.error };
  if (res.rows.length === 0) {
    return { ok: false, status: 400, error: "no rows match the selected filters" };
  }

  if (def.cardType === "table") {
    const columns = [...(compiled.plan.groupBy ?? []), compiled.alias];
    const rows = res.rows.map((r) =>
      columns.map((c) => {
        const v = r[c];
        return v === undefined ? null : (v as string | number | null);
      })
    );
    return { ok: true, cardType: "table", table: { caption: title, columns, rows } };
  }

  // chart
  const columns = [...(compiled.plan.groupBy ?? []), compiled.alias];
  const chart = buildChartFromAnalyticalTable({
    table: { rows: res.rows, columns },
    summary,
    question: title,
    title,
  });
  if (!chart) {
    return { ok: false, status: 400, error: "could not build a chart for this selection" };
  }
  if (def.viz?.chartType) chart.type = def.viz.chartType;
  if (def.viz?.barLayout) chart.barLayout = def.viz.barLayout;
  chart.cardDefinition = def;
  return { ok: true, cardType: "chart", chart };
}

/** In-memory fallback loader (used only when DuckDB is unavailable). */
async function loadRowsForChat(chat: ChatDocument): Promise<Record<string, any>[]> {
  const { loadLatestData } = await import("../utils/dataLoader.js");
  return (await loadLatestData(chat)) as Record<string, any>[];
}

async function resolveComposeContext(
  req: Request,
  username: string
): Promise<
  | { ok: true; dashboardId: string; sessionId: string; chat: ChatDocument }
  | { ok: false; status: number; error: string }
> {
  const { dashboardId } = req.params as { dashboardId: string };
  const dashboard = await getDashboardById(dashboardId, username);
  if (!dashboard) return { ok: false, status: 404, error: "Dashboard not found" };

  const body = composeRequestSchema.parse(req.body);
  const sessionId = body.cardDefinition.sessionId ?? dashboard.sessionId;
  if (!sessionId) {
    return {
      ok: false,
      status: 400,
      error: "This dashboard has no source session — cannot compose a data-bound card.",
    };
  }
  const { getChatBySessionIdForUser } = await import("../models/chat.model.js");
  const chat = await getChatBySessionIdForUser(sessionId, username);
  if (!chat) return { ok: false, status: 404, error: "Source session not found" };
  return { ok: true, dashboardId, sessionId, chat };
}

/**
 * GET /api/dashboards/:dashboardId/builder-metadata — the guided card
 * builder's data source: the measures (+ legal aggregations) and dimensions
 * (+ distinct values) the picker can offer. Gated by DASHBOARD_CARD_BUILDER_ENABLED.
 */
export const builderMetadataController = async (req: Request, res: Response) => {
  if (!isFlagOn("DASHBOARD_CARD_BUILDER_ENABLED")) {
    res.status(404).json({ error: "card builder not enabled" });
    return;
  }
  try {
    const username = requireUsername(req);
    const { dashboardId } = req.params as { dashboardId: string };
    const dashboard = await getDashboardById(dashboardId, username);
    if (!dashboard) {
      res.status(404).json({ error: "Dashboard not found" });
      return;
    }
    const sessionId = dashboard.sessionId;
    if (!sessionId) {
      res.status(400).json({ error: "This dashboard has no source session." });
      return;
    }
    const { getChatBySessionIdForUser } = await import("../models/chat.model.js");
    const chat = await getChatBySessionIdForUser(sessionId, username);
    if (!chat) {
      res.status(404).json({ error: "Source session not found" });
      return;
    }
    res.json(buildBuilderMetadata(chat.dataSummary, chat.semanticModel));
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    logger.error("[builderMetadata] Error:", error);
    res.status(400).json({ error: errorMessage(error) || "Failed to load builder metadata" });
  }
};

/** POST /api/dashboards/:dashboardId/tiles/preview — compute, do NOT persist. */
export const previewTileController = async (req: Request, res: Response) => {
  if (!isFlagOn("DASHBOARD_CARD_BUILDER_ENABLED")) {
    res.status(404).json({ error: "card builder not enabled" });
    return;
  }
  try {
    const username = requireUsername(req);
    const ctx = await resolveComposeContext(req, username);
    if (!ctx.ok) {
      res.status(ctx.status).json({ error: ctx.error });
      return;
    }
    const body = composeRequestSchema.parse(req.body);
    const art = await buildTileArtifact(body.cardDefinition, {
      sessionId: ctx.sessionId,
      chat: ctx.chat,
      title: body.title,
    });
    if (!art.ok) {
      res.status(art.status).json({ error: art.error, allowed: art.allowed });
      return;
    }
    res.json(art);
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    logger.error("[previewTile] Error:", error);
    res.status(400).json({ error: errorMessage(error) || "Failed to preview tile" });
  }
};

/**
 * POST /api/dashboards/:dashboardId/scorecards/recompute — re-run every
 * Executive-Summary scorecard's query against the CURRENT dataset and persist
 * the refreshed snapshots (value + delta + sparkline). Gated by
 * SCORECARD_EXEC_SUMMARY_ENABLED.
 */
export const recomputeScorecardsController = async (req: Request, res: Response) => {
  if (!isFlagOn("SCORECARD_EXEC_SUMMARY_ENABLED")) {
    res.status(404).json({ error: "scorecards not enabled" });
    return;
  }
  try {
    const username = requireUsername(req);
    const { dashboardId } = req.params as { dashboardId: string };
    const dashboard = await getDashboardById(dashboardId, username);
    if (!dashboard) {
      res.status(404).json({ error: "Dashboard not found" });
      return;
    }
    const scorecards = dashboard.scorecards ?? [];
    if (scorecards.length === 0) {
      res.json(dashboard);
      return;
    }
    const sessionId = dashboard.sessionId;
    if (!sessionId) {
      res.status(400).json({ error: "This dashboard has no source session." });
      return;
    }
    const { getChatBySessionIdForUser } = await import("../models/chat.model.js");
    const chat = await getChatBySessionIdForUser(sessionId, username);
    if (!chat) {
      res.status(404).json({ error: "Source session not found" });
      return;
    }
    const loadRows = () => loadRowsForChat(chat);
    const recomputed = await Promise.all(
      scorecards.map(async (sc) => ({
        ...sc,
        snapshot: await computeScorecard(sc, {
          summary: chat.dataSummary,
          sessionId,
          chat,
          model: chat.semanticModel,
          loadRows,
          dataVersion: (chat as { currentDataVersion?: number }).currentDataVersion,
        }),
      }))
    );
    const updated = await patchDashboard(dashboardId, username, { scorecards: recomputed });
    res.json(updated);
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    logger.error("[recomputeScorecards] Error:", error);
    res.status(400).json({ error: errorMessage(error) || "Failed to recompute scorecards" });
  }
};

/** POST /api/dashboards/:dashboardId/tiles/compose — compute AND persist. */
export const composeTileController = async (req: Request, res: Response) => {
  if (!isFlagOn("DASHBOARD_CARD_BUILDER_ENABLED")) {
    res.status(404).json({ error: "card builder not enabled" });
    return;
  }
  try {
    const username = requireUsername(req);
    const ctx = await resolveComposeContext(req, username);
    if (!ctx.ok) {
      res.status(ctx.status).json({ error: ctx.error });
      return;
    }
    const body = composeRequestSchema.parse(req.body);
    const art = await buildTileArtifact(body.cardDefinition, {
      sessionId: ctx.sessionId,
      chat: ctx.chat,
      title: body.title,
    });
    if (!art.ok) {
      res.status(art.status).json({ error: art.error, allowed: art.allowed });
      return;
    }

    let updated;
    if (art.cardType === "scorecard") {
      updated = await addScorecardToDashboard(ctx.dashboardId, username, art.scorecard, body.sheetId);
    } else if (art.cardType === "table") {
      updated = await addTableToDashboard(ctx.dashboardId, username, art.table, body.sheetId);
    } else {
      updated = await addChartToDashboard(ctx.dashboardId, username, art.chart, body.sheetId);
    }
    res.json(updated);
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    logger.error("[composeTile] Error:", error);
    res.status(400).json({ error: errorMessage(error) || "Failed to compose tile" });
  }
};
