/**
 * Run Automation Service
 * Executes a saved automation on a session. For now only data_op steps are run;
 * when applied, chart responses are generated for the session data after each step.
 */
import { Response } from "express";
import { getChatBySessionIdForUser, addMessagesBySessionId } from "../../models/chat.model.js";
import { loadLatestData } from "../../utils/dataLoader.js";
import { sendSSE, setSSEHeaders } from "../../utils/sse.helper.js";
import { executeDataOperation } from "../../lib/dataOps/dataOpsOrchestrator.js";
import type { DataOpsIntent } from "../../lib/dataOps/dataOpsOrchestrator.js";
import { createDashboard, addChartToDashboard, getUserDashboards } from "../../models/dashboard.model.js";
import { getAutomationById } from "../../models/automation.model.js";
import type { AutomationStep, AutomationStepDataOp } from "../../shared/schema.js";
import type { ChartSpec } from "../../shared/schema.js";
import { createDataSummary } from "../../lib/fileParser.js";
import { analyzeUpload } from "../../lib/dataAnalyzer.js";
import { processChatMessage } from "../chat/chat.service.js";

const LAST_CREATED_DASHBOARD_KEY = "__last_created__";

/** Returns a unique dashboard name; if baseName exists, appends " 1", " 2", etc. */
function uniqueDashboardName(baseName: string, existingNames: string[]): string {
  const normalized = (s: string) => s.toLowerCase().trim();
  const base = baseName.trim();
  const existingSet = new Set(existingNames.map(normalized));
  if (!existingSet.has(normalized(base))) return base;
  for (let n = 1; n <= 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!existingSet.has(normalized(candidate))) return candidate;
  }
  return `${base} ${Date.now()}`;
}

export interface RunAutomationResult {
  success: boolean;
  automationName: string;
  stepsRun: number;
  stepsTotal: number;
  results: Array<{
    stepIndex: number;
    type: string;
    success: boolean;
    message?: string;
    dashboardId?: string;
  }>;
  error?: string;
}

function buildIntentFromStep(step: AutomationStepDataOp): DataOpsIntent {
  const params = step.params || {};
  return {
    operation: (step.operation as DataOpsIntent["operation"]) || "unknown",
    requiresClarification: false,
    ...params,
  };
}

export async function runAutomation(
  username: string,
  sessionId: string,
  automationId: string
): Promise<RunAutomationResult> {
  const automation = await getAutomationById(automationId, username);
  if (!automation) {
    return {
      success: false,
      automationName: "",
      stepsRun: 0,
      stepsTotal: 0,
      results: [],
      error: "Automation not found",
    };
  }

  const chatDoc = await getChatBySessionIdForUser(sessionId, username);
  if (!chatDoc) {
    return {
      success: false,
      automationName: automation.name,
      stepsRun: 0,
      stepsTotal: automation.steps.length,
      results: [],
      error: "Session not found",
    };
  }

  // Run only message (chat) steps – everything goes through chat
  const stepsToRun = automation.steps.filter((s) => s.type === "message");

  const results: RunAutomationResult["results"] = [];
  let lastCreatedDashboardId: string | null = null;
  let currentData: Record<string, any>[] = [];
  let currentDoc = chatDoc;
  let stepsRun = 0;
  let dataLoaded = false;

  function ensureDataLoaded(): Promise<void> {
    if (dataLoaded) return Promise.resolve();
    dataLoaded = true;
    return loadLatestData(currentDoc).then((d) => {
      currentData = d;
    });
  }

  for (let i = 0; i < stepsToRun.length; i++) {
    const step = stepsToRun[i];

    try {
      if (step.type === "data_op") {
        await ensureDataLoaded();
        const intent = buildIntentFromStep(step);
        const out = await executeDataOperation(
          intent,
          currentData,
          sessionId,
          currentDoc,
          undefined,
          currentDoc.messages || []
        );
        if (out.requiresClarification && out.clarificationMessage) {
          results.push({
            stepIndex: i + 1,
            type: "data_op",
            success: false,
            message: out.clarificationMessage,
          });
          continue;
        }
        // Use operation result data directly; avoid re-upload/reload from blob
        if (out.data && out.data.length !== undefined) {
          currentData = out.data;
          currentDoc = (await getChatBySessionIdForUser(sessionId, username))!;
        }
        results.push({
          stepIndex: i + 1,
          type: "data_op",
          success: true,
          message: out.answer,
        });
        stepsRun++;
      } else if (step.type === "message") {
        const userContent = step.userMessage?.trim();
        if (!userContent) {
          results.push({ stepIndex: i + 1, type: "message", success: false, message: "Empty message step" });
          continue;
        }
        try {
          const chatResult = await processChatMessage({ sessionId, message: userContent, username });
          results.push({
            stepIndex: i + 1,
            type: "message",
            success: true,
            message: chatResult.answer?.slice(0, 200) || "Done",
          });
          stepsRun++;
        } catch (msgErr: any) {
          results.push({
            stepIndex: i + 1,
            type: "message",
            success: false,
            message: msgErr?.message || String(msgErr),
          });
        }
      } else if (step.type === "create_dashboard") {
        const existing = await getUserDashboards(username);
        const existingNames = existing.map((d) => d.name);
        const nameToUse = uniqueDashboardName(step.name, existingNames);
        const dash = await createDashboard(
          username,
          nameToUse,
          step.charts || []
        );
        lastCreatedDashboardId = dash.id;
        results.push({
          stepIndex: i + 1,
          type: "create_dashboard",
          success: true,
          message: nameToUse === step.name
            ? `Created dashboard "${step.name}"`
            : `Created dashboard "${nameToUse}" (name "${step.name}" already existed)`,
          dashboardId: dash.id,
        });
        stepsRun++;
      } else if (step.type === "add_charts") {
        const dashboardId =
          step.dashboardId === LAST_CREATED_DASHBOARD_KEY
            ? lastCreatedDashboardId
            : step.dashboardId;
        if (!dashboardId) {
          results.push({
            stepIndex: i + 1,
            type: "add_charts",
            success: false,
            message: "No dashboard to add charts to (use create_dashboard first or set dashboardId)",
          });
          continue;
        }
        for (const chart of step.charts) {
          await addChartToDashboard(dashboardId, username, chart, step.sheetId);
        }
        results.push({
          stepIndex: i + 1,
          type: "add_charts",
          success: true,
          message: `Added ${step.charts.length} chart(s) to dashboard`,
          dashboardId,
        });
        stepsRun++;
      }
    } catch (err: any) {
      const message = err?.message || String(err);
      results.push({
        stepIndex: i + 1,
        type: step.type,
        success: false,
        message,
      });
      return {
        success: false,
        automationName: automation.name,
        stepsRun,
        stepsTotal: automation.steps.length,
        results,
        error: message,
      };
    }
  }

  return {
    success: true,
    automationName: automation.name,
    stepsRun,
    stepsTotal: stepsToRun.length,
    results,
  };
}

/** Helper: send SSE and persist step to chat; optionally include charts for this step. Returns false if client disconnected */
async function sendStepAndPersist(
  res: Response,
  sessionId: string,
  stepIndex: number,
  stepsTotal: number,
  type: string,
  message: string,
  success: boolean,
  charts?: ChartSpec[]
): Promise<boolean> {
  const stepLine = `**Step ${stepIndex}/${stepsTotal}** (${type}): ${message}`;
  try {
    await addMessagesBySessionId(sessionId, [
      { role: "assistant", content: stepLine, timestamp: Date.now(), charts: charts ?? [] },
    ]);
  } catch (e) {
    console.warn("Failed to persist automation step to chat:", e);
  }
  return sendSSE(res, "step", {
    stepIndex,
    stepsTotal,
    type,
    message,
    success,
    charts: charts ?? undefined,
  });
}

export interface RunAutomationStreamOptions {
  /** When set, use this name for the first create_dashboard step (e.g. user chose "My Report" in the modal). */
  newDashboardName?: string;
}

/**
 * Run automation with SSE: executes steps one-by-one, sends each step to the client
 * and appends it to the chat so the user sees progress in the conversation.
 */
export async function runAutomationStream(
  username: string,
  sessionId: string,
  automationId: string,
  res: Response,
  options: RunAutomationStreamOptions = {}
): Promise<void> {
  const { newDashboardName: userDashboardName } = options;
  setSSEHeaders(res);

  const checkConnection = (): boolean =>
    !res.writableEnded && !res.destroyed && res.writable;

  res.on("close", () => {
    if (!res.writableEnded) console.log("Client disconnected from automation stream");
  });

  try {
    const automation = await getAutomationById(automationId, username);
    if (!automation) {
      sendSSE(res, "error", { message: "Automation not found" });
      res.end();
      return;
    }

    const chatDoc = await getChatBySessionIdForUser(sessionId, username);
    if (!chatDoc) {
      sendSSE(res, "error", { message: "Session not found" });
      res.end();
      return;
    }

    // Run only message (chat) steps – exactly as if the user had typed each step in the chat.
    // Each step runs via processChatMessage(); we do NOT reload/re-upload the session between steps.
    // processChatMessage loads the latest data from blob (or uses full data for add-column steps so columns are preserved).
    // Works the same for file uploads and Snowflake-imported tables (data lives in blob).
    const stepsToRun = automation.steps.filter((s) => s.type === "message");
    if (!sendSSE(res, "start", { automationName: automation.name, stepsTotal: stepsToRun.length })) {
      res.end();
      return;
    }
    if (stepsToRun.length === 0) {
      sendSSE(res, "done", {
        success: true,
        automationName: automation.name,
        stepsRun: 0,
        stepsTotal: 0,
        results: [],
      });
      res.end();
      return;
    }

    const results: RunAutomationResult["results"] = [];
    // Collect all charts generated while running this automation so we can
    // save them into a new dashboard at the end.
    const collectedCharts: ChartSpec[] = [];
    let lastCreatedDashboardId: string | null = null;
    let currentData: Record<string, any>[] = [];
    let currentDoc = chatDoc;
    let stepsRun = 0;
    let dataLoaded = false;
    let usedUserDashboardName = false; // use userDashboardName only for the first create_dashboard

    function ensureDataLoaded(): Promise<void> {
      if (dataLoaded) return Promise.resolve();
      dataLoaded = true;
      return loadLatestData(currentDoc).then((d) => {
        currentData = d;
      });
    }

    /** Generate charts for current data and return them for the step message (for data_op steps). */
    async function generateChartsForStep(): Promise<ChartSpec[] | undefined> {
      if (!currentData || currentData.length === 0) return undefined;
      try {
        const summary = createDataSummary(currentData);
        const { charts } = await analyzeUpload(currentData, summary, undefined, true);
        return charts && charts.length > 0 ? charts : undefined;
      } catch (err) {
        console.warn("Automation: chart generation after data op failed:", err);
        return undefined;
      }
    }

    for (let i = 0; i < stepsToRun.length; i++) {
      if (!checkConnection()) break;

      const step = stepsToRun[i];
      const stepIndex = i + 1;
      const stepsTotal = stepsToRun.length;

      try {
        if (step.type === "data_op") {
          await ensureDataLoaded();
          const intent = buildIntentFromStep(step);
          const out = await executeDataOperation(
            intent,
            currentData,
            sessionId,
            currentDoc,
            undefined,
            currentDoc.messages || []
          );
          if (out.requiresClarification && out.clarificationMessage) {
            results.push({
              stepIndex,
              type: "data_op",
              success: false,
              message: out.clarificationMessage,
            });
            await sendStepAndPersist(
              res,
              sessionId,
              stepIndex,
              stepsTotal,
              "data_op",
              out.clarificationMessage || "Needs clarification",
              false
            );
            continue;
          }
          if (out.data && out.data.length !== undefined) {
            currentData = out.data;
            currentDoc = (await getChatBySessionIdForUser(sessionId, username))!;
          }
          results.push({
            stepIndex,
            type: "data_op",
            success: true,
            message: out.answer,
          });
          stepsRun++;
          // Generate charts for this data so the user sees chart responses for the data they're applying the automation to
          const stepCharts = await generateChartsForStep();
          if (stepCharts && stepCharts.length > 0) {
            collectedCharts.push(...stepCharts);
          }
          const sent = await sendStepAndPersist(
            res,
            sessionId,
            stepIndex,
            stepsTotal,
            "data_op",
            out.answer || "Data operation completed",
            true,
            stepCharts
          );
          if (!sent) break;
        } else if (step.type === "message") {
          // Run this step exactly as if the user had typed it: processChatMessage loads data, runs the op, persists. No reload.
          const userContent = step.userMessage.trim();
          if (!userContent) {
            results.push({ stepIndex, type: "message", success: false, message: "Empty message step" });
            await sendStepAndPersist(res, sessionId, stepIndex, stepsTotal, "message", "Empty message step", false);
            continue;
          }
          if (!sendSSE(res, "step_user_message", { stepIndex, stepsTotal, content: userContent })) break;
          try {
            const chatResult = await processChatMessage({
              sessionId,
              message: userContent,
              username,
            });
            results.push({
              stepIndex,
              type: "message",
              success: true,
              message: chatResult.answer?.slice(0, 200) || "Done",
            });
            stepsRun++;
            if (chatResult.charts && Array.isArray(chatResult.charts) && chatResult.charts.length > 0) {
              collectedCharts.push(...chatResult.charts);
            }
            const sent = sendSSE(res, "step_assistant_response", {
              stepIndex,
              stepsTotal,
              content: chatResult.answer || "",
              charts: chatResult.charts ?? [],
              insights: chatResult.insights,
            });
            if (!sent) break;
          } catch (msgErr: any) {
            const errMsg = msgErr?.message || String(msgErr);
            results.push({ stepIndex, type: "message", success: false, message: errMsg });
            await sendStepAndPersist(res, sessionId, stepIndex, stepsTotal, "message", errMsg, false);
            sendSSE(res, "done", {
              success: false,
              automationName: automation.name,
              stepsRun,
              stepsTotal: stepsToRun.length,
              results,
              error: errMsg,
            });
            res.end();
            return;
          }
        } else if (step.type === "create_dashboard") {
          const existing = await getUserDashboards(username);
          const existingNames = existing.map((d) => d.name);
          const baseName = !usedUserDashboardName && userDashboardName?.trim()
            ? userDashboardName.trim()
            : step.name;
          usedUserDashboardName = !!userDashboardName?.trim();
          const nameToUse = uniqueDashboardName(baseName, existingNames);
          const chartsForDashboard =
            step.charts?.length > 0
              ? step.charts
              : (currentDoc.charts && currentDoc.charts.length > 0 ? currentDoc.charts : []);
          const dash = await createDashboard(
            username,
            nameToUse,
            chartsForDashboard
          );
          lastCreatedDashboardId = dash.id;
          const msg =
            nameToUse === baseName
              ? `Created dashboard "${nameToUse}"`
              : `Created dashboard "${nameToUse}" (name "${baseName}" already existed)`;
          results.push({
            stepIndex,
            type: "create_dashboard",
            success: true,
            message: msg,
            dashboardId: dash.id,
          });
          stepsRun++;
          const sent = await sendStepAndPersist(
            res,
            sessionId,
            stepIndex,
            stepsTotal,
            "create_dashboard",
            msg,
            true
          );
          if (!sent) break;
        } else if (step.type === "add_charts") {
          const dashboardId =
            step.dashboardId === LAST_CREATED_DASHBOARD_KEY
              ? lastCreatedDashboardId
              : step.dashboardId;
          if (!dashboardId) {
            results.push({
              stepIndex,
              type: "add_charts",
              success: false,
              message: "No dashboard to add charts to (use create_dashboard first or set dashboardId)",
            });
            await sendStepAndPersist(
              res,
              sessionId,
              stepIndex,
              stepsTotal,
              "add_charts",
              "No dashboard to add charts to.",
              false
            );
            continue;
          }
          // Use step.charts if present; otherwise use session's charts so the new dashboard gets the current session charts
          const chartsToAdd =
            step.charts?.length > 0
              ? step.charts
              : (currentDoc.charts && currentDoc.charts.length > 0 ? currentDoc.charts : []);
          for (const chart of chartsToAdd) {
            await addChartToDashboard(dashboardId, username, chart, step.sheetId);
          }
          const msg =
            chartsToAdd.length === 0
              ? "No charts to add (step had none stored and session has no charts)"
              : `Added ${chartsToAdd.length} chart(s) to dashboard`;
          results.push({
            stepIndex,
            type: "add_charts",
            success: true,
            message: msg,
            dashboardId,
          });
          stepsRun++;
          const sent = await sendStepAndPersist(
            res,
            sessionId,
            stepIndex,
            stepsTotal,
            "add_charts",
            msg,
            true
          );
          if (!sent) break;
        }
      } catch (err: any) {
        const message = err?.message || String(err);
        results.push({
          stepIndex,
          type: step.type,
          success: false,
          message,
        });
        await sendStepAndPersist(res, sessionId, stepIndex, stepsTotal, step.type, message, false);
        sendSSE(res, "done", {
          success: false,
          automationName: automation.name,
          stepsRun,
          stepsTotal: stepsToRun.length,
          results,
          error: message,
        });
        res.end();
        return;
      }
    }

    // After running all steps, automatically create a dashboard with all charts
    // generated during this automation run (if any).
    if (collectedCharts.length > 0) {
      try {
        const existing = await getUserDashboards(username);
        const existingNames = existing.map((d) => d.name);
        const timestampLabel = new Date().toISOString().replace("T", " ").slice(0, 19);
        const baseName = `${automation.name} - ${timestampLabel}`;
        const nameToUse = uniqueDashboardName(baseName, existingNames);
        const dash = await createDashboard(
          username,
          nameToUse,
          collectedCharts
        );
        const msg = `Created automation dashboard "${nameToUse}" with ${collectedCharts.length} chart${collectedCharts.length === 1 ? "" : "s"}.`;
        results.push({
          stepIndex: results.length + 1,
          type: "create_dashboard",
          success: true,
          message: msg,
          dashboardId: dash.id,
        });
      } catch (dashboardError) {
        console.error("Automation: failed to auto-create dashboard from collected charts:", dashboardError);
      }
    }

    sendSSE(res, "done", {
      success: true,
      automationName: automation.name,
      stepsRun,
      stepsTotal: stepsToRun.length,
      results,
    });
  } catch (err: any) {
    sendSSE(res, "error", { message: err?.message || String(err) });
  } finally {
    res.end();
  }
}
