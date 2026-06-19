/**
 * Wave WR8 (incremental refresh) · client API for the "Update data" flow.
 *
 * Mirrors `automationsApi` + `runAutomationStream`, but the commit endpoints
 * are multipart (a file part) so we use raw `fetch` with `FormData` and the
 * same manual SSE reader loop. The SSE events are the automation replay events
 * (so `AutomationReplayBanner` renders them) plus a final `refresh_complete`.
 */

import { api } from "@/lib/httpClient";
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
}

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
  headers: HeadersInit,
  callbacks: RunRefreshCallbacks
): { abort: () => void } => {
  const controller = new AbortController();
  void (async () => {
    try {
      const res = await fetch(route, {
        method: "POST",
        headers,
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
