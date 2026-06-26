/**
 * Wave A9 · Client API helpers for the Automations feature.
 *
 * Mirrors the `dashboardsApi` shape (small object literal with `api.*`
 * calls). The SSE `run` endpoint isn't wrapped here because EventSource
 * needs different plumbing — see `runAutomation` in the replay-banner
 * hook (Wave A15).
 */

import { api } from "@/lib/httpClient";
import { getAuthorizationHeader } from "@/auth/msalToken";
import type {
  Automation,
  AutomationDryRunResult,
  AutomationSummary,
  AutomationColumnMapping,
} from "@/shared/schema";

export const automationsApi = {
  list: () =>
    api.get<{ automations: AutomationSummary[] }>("/api/automations"),
  get: (id: string) =>
    api.get<{ automation: Automation }>(`/api/automations/${id}`),
  create: (sessionId: string, name: string, description?: string) =>
    api.post<{ id: string; name: string; stats: Record<string, number> }>(
      "/api/automations",
      { sessionId, name, description }
    ),
  remove: (id: string) => api.delete(`/api/automations/${id}`),
  dryRun: (id: string, sessionId: string) =>
    api.post<AutomationDryRunResult>(`/api/automations/${id}/dry-run`, {
      sessionId,
    }),
};

/**
 * Open an SSE stream against `POST /api/automations/:id/run`.
 *
 * EventSource only supports GET, so we use `fetch` + a manual reader
 * loop to parse `event: <name>\ndata: <json>\n\n` chunks. Returns an
 * abort handle so the caller can cancel mid-stream when the user
 * dismisses the replay banner.
 */
export interface RunAutomationCallbacks {
  onEvent: (event: AutomationSseEvent) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export type AutomationSseEvent =
  | { type: "automation_started"; automationId: string; recipeLength: number }
  | {
      type: "automation_progress";
      phase: "preparing_dataset" | "replaying_turn";
      step: number;
      total: number;
      detail?: string;
    }
  | {
      type: "automation_halted";
      ordinal: number;
      stepId?: string;
      error: string;
    }
  | {
      type: "automation_complete";
      questionsReplayed: number;
      dashboardsCreated: number;
    }
  | { type: "stream_end"; ok: boolean };

export interface RunAutomationOptions {
  sessionId: string;
  columnMapping?: AutomationColumnMapping;
  resumeFromOrdinal?: number;
}

export const runAutomationStream = (
  id: string,
  options: RunAutomationOptions,
  callbacks: RunAutomationCallbacks
): { abort: () => void } => {
  const controller = new AbortController();
  const route = options.resumeFromOrdinal
    ? `/api/automations/${id}/run/resume`
    : `/api/automations/${id}/run`;

  void (async () => {
    try {
      // Raw fetch bypasses the axios apiClient interceptor — attach the Bearer
      // token explicitly (see docs/conventions/authed-raw-fetch.md).
      const auth = await getAuthorizationHeader();
      const res = await fetch(route, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        credentials: "include",
        body: JSON.stringify(options),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Replay request failed: ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Parse SSE-style chunks: "event: <name>\ndata: <json>\n\n"
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
              const parsed = JSON.parse(data) as AutomationSseEvent;
              callbacks.onEvent(parsed);
            } catch {
              // Ignore unparseable chunk; keep going.
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

  return {
    abort: () => controller.abort(),
  };
};
