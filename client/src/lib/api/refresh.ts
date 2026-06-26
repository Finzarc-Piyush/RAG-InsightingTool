/**
 * Wave WR8 (incremental refresh) · client API for the "Update data" flow.
 *
 * Mirrors `automationsApi` + `runAutomationStream`, but the commit endpoints
 * are multipart (a file part) so we use raw `fetch` with `FormData` and the
 * same manual SSE reader loop. The SSE events are the automation replay events
 * (so `AutomationReplayBanner` renders them) plus a final `refresh_complete`.
 */

import { api } from "@/lib/httpClient";
import { getAuthorizationHeader } from "@/auth/msalToken";
import type {
  AutomationDryRunResult,
  AutomationColumnMapping,
} from "@/shared/schema";
import type { AutomationSseEvent } from "./automations";

export interface RefreshPreflightResult {
  diff: {
    rowsBefore: number;
    rowsAfterReplace: number;
    rowsAfterAppend: number;
    columnsBefore: number;
    columnsAfter: number;
  };
  columnMapping: AutomationDryRunResult;
  newColumns: string[];
  appendKey: string[];
  recipe: { turns: number; charts: number; dashboards: number; empty: boolean };
}

export type RefreshSseEvent =
  | AutomationSseEvent
  | {
      type: "refresh_complete";
      ok: boolean;
      fromDataVersion?: number;
      toDataVersion?: number;
      questionsReplayed?: number;
      dashboardId?: string;
    };

export interface RunRefreshCallbacks {
  onEvent: (event: RefreshSseEvent) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export interface RunRefreshOptions {
  file?: File;
  policy: "replace" | "append";
  columnMapping?: AutomationColumnMapping;
  appendKey?: string[];
  versionLabel?: string;
  /** WR11 · also run a fresh-planner discovery pass for net-new insights. */
  discover?: boolean;
}

export interface RefreshHistoryView {
  canRollback: boolean;
  currentVersion?: number;
  currentLabel?: string;
  priorVersion?: number;
  priorLabel?: string;
  hasSnowflakeSource: boolean;
  scheduleEnabled: boolean;
}

/** GET the version/label info for the "Data: as of …" badge + rollback menu. */
export const refreshHistory = (sessionId: string): Promise<RefreshHistoryView> =>
  api.get<RefreshHistoryView>(`/api/sessions/${sessionId}/refresh/history`);

/** Undo the last refresh — restores prior data + answers + dashboard. */
export const rollbackRefresh = (
  sessionId: string
): Promise<{ ok: boolean; restoredLabel?: string; restoredToVersion?: number }> =>
  api.post(`/api/sessions/${sessionId}/refresh/rollback`, {});

export interface RefreshCompareRow {
  title: string;
  type: string;
  priorTotal: number;
  currentTotal: number;
  delta: number;
  deltaPct: number | null;
}
export interface RefreshCompareResult {
  available: boolean;
  priorLabel?: string;
  currentLabel?: string;
  rows: RefreshCompareRow[];
}

/** GET the prior-vs-current per-chart deltas for the compare view. */
export const refreshCompare = (sessionId: string): Promise<RefreshCompareResult> =>
  api.get<RefreshCompareResult>(`/api/sessions/${sessionId}/refresh/compare`);

/** Set/clear the Snowflake auto-refresh schedule (WR13). */
export const setRefreshSchedule = (
  sessionId: string,
  body: { enabled: boolean; intervalHours?: number }
): Promise<{ ok: boolean }> =>
  api.put(`/api/sessions/${sessionId}/refresh/schedule`, body);

/** Preflight: returns the diff + drift mapping + recipe summary (no mutation). */
export const refreshPreflight = (
  sessionId: string,
  file: File
): Promise<RefreshPreflightResult> => {
  const form = new FormData();
  form.append("file", file);
  return api.post<RefreshPreflightResult>(
    `/api/sessions/${sessionId}/refresh/preflight`,
    form
  );
};

/** Shared SSE reader loop over a streaming `fetch` response. */
const streamSse = (
  route: string,
  body: BodyInit,
  headers: Record<string, string>,
  callbacks: RunRefreshCallbacks
): { abort: () => void } => {
  const controller = new AbortController();
  void (async () => {
    try {
      // Raw fetch bypasses the axios apiClient interceptor — attach the Bearer
      // token explicitly (see docs/conventions/authed-raw-fetch.md). Merge keeps
      // the caller's Content-Type (or its deliberate absence for multipart).
      const auth = await getAuthorizationHeader();
      const res = await fetch(route, {
        method: "POST",
        headers: { ...headers, ...auth },
        credentials: "include",
        body,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Refresh request failed: ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const lines = chunk.split("\n");
          let evt: string | null = null;
          let data: string | null = null;
          for (const line of lines) {
            if (line.startsWith("event: ")) evt = line.slice(7).trim();
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (evt && data) {
            try {
              callbacks.onEvent(JSON.parse(data) as RefreshSseEvent);
            } catch {
              /* ignore unparseable chunk */
            }
          }
        }
      }
      callbacks.onClose?.();
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        callbacks.onClose?.();
        return;
      }
      callbacks.onError?.(err as Error);
    }
  })();
  return { abort: () => controller.abort() };
};

/** Commit a file-source refresh (multipart → SSE). */
export const runRefreshStream = (
  sessionId: string,
  options: RunRefreshOptions,
  callbacks: RunRefreshCallbacks
): { abort: () => void } => {
  const form = new FormData();
  if (options.file) form.append("file", options.file);
  form.append("policy", options.policy);
  if (options.columnMapping) {
    form.append("columnMapping", JSON.stringify(options.columnMapping));
  }
  if (options.appendKey) form.append("appendKey", JSON.stringify(options.appendKey));
  if (options.versionLabel) form.append("versionLabel", options.versionLabel);
  if (options.discover) form.append("discover", "true");
  // No explicit Content-Type — the browser sets the multipart boundary.
  return streamSse(
    `/api/sessions/${sessionId}/refresh`,
    form,
    {},
    callbacks
  );
};

/** Commit a one-click Snowflake re-query refresh (JSON → SSE). */
export const runSnowflakeRefreshStream = (
  sessionId: string,
  options: { versionLabel?: string },
  callbacks: RunRefreshCallbacks
): { abort: () => void } =>
  streamSse(
    `/api/sessions/${sessionId}/refresh/snowflake`,
    JSON.stringify(options ?? {}),
    { "Content-Type": "application/json" },
    callbacks
  );
