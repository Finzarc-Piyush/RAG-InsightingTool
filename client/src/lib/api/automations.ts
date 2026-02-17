import { api } from "@/lib/httpClient";
import { getUserEmail } from "@/utils/userStorage";
import { API_BASE_URL } from "@/lib/config";
import type { Automation, AutomationStep, ChartSpec } from "@/shared/schema";

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

export interface AutomationStreamCallbacks {
  onStart?: (data: { automationName: string; stepsTotal: number }) => void;
  onStep?: (data: {
    stepIndex: number;
    stepsTotal: number;
    type: string;
    message: string;
    success: boolean;
    charts?: ChartSpec[];
  }) => void;
  /** For message steps: user message shown first in chat */
  onStepUserMessage?: (data: { stepIndex: number; stepsTotal: number; content: string }) => void;
  /** For message steps: assistant response (analysis/correlation/modelling) with charts */
  onStepAssistantResponse?: (data: {
    stepIndex: number;
    stepsTotal: number;
    content: string;
    charts?: ChartSpec[];
    insights?: Array<{ id: number; text: string }>;
  }) => void;
  onDone?: (data: RunAutomationResult) => void;
  onError?: (message: string) => void;
}

export interface RunAutomationStreamOptions {
  /** Name for the new dashboard when automation has create_dashboard steps (user enters in modal). */
  newDashboardName?: string;
}

/**
 * Run automation with SSE: steps are streamed one-by-one; use callbacks to show progress in chat.
 */
export async function runAutomationStream(
  automationId: string,
  sessionId: string,
  callbacks: AutomationStreamCallbacks,
  options?: RunAutomationStreamOptions
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const userEmail = getUserEmail();
  if (userEmail) {
    headers["X-User-Email"] = userEmail;
  }

  const body: { automationId: string; sessionId: string; newDashboardName?: string } = {
    automationId,
    sessionId,
  };
  if (options?.newDashboardName?.trim()) {
    body.newDashboardName = options.newDashboardName.trim();
  }

  const response = await fetch(`${API_BASE_URL}/api/automations/run/stream`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    callbacks.onError?.(err?.error || `HTTP ${response.status}`);
    return;
  }

  const stream = response.body;
  if (!stream) {
    callbacks.onError?.("No response body");
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedDoneOrError = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let messageEnd: number;
      while ((messageEnd = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.substring(0, messageEnd);
        buffer = buffer.substring(messageEnd + 2);

        let eventType = "message";
        let dataStr = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataStr = line.slice(6).trim();
        }

        if (!dataStr) continue;
        try {
          const data = JSON.parse(dataStr);
          switch (eventType) {
            case "start":
              callbacks.onStart?.(data);
              break;
            case "step":
              callbacks.onStep?.(data);
              break;
            case "step_user_message":
              callbacks.onStepUserMessage?.(data);
              break;
            case "step_assistant_response":
              callbacks.onStepAssistantResponse?.(data);
              break;
            case "done":
              receivedDoneOrError = true;
              callbacks.onDone?.(data);
              break;
            case "error":
              receivedDoneOrError = true;
              callbacks.onError?.(data?.message || "Automation error");
              break;
            default:
              break;
          }
        } catch {
          // ignore parse errors
        }
      }
    }
    if (!receivedDoneOrError) {
      callbacks.onError?.("Connection ended unexpectedly");
    }
  } finally {
    reader.releaseLock();
  }
}

export const automationsApi = {
  list: () => api.get<{ automations: Automation[] }>("/api/automations"),
  get: (id: string) => api.get<Automation>(`/api/automations/${id}`),
  create: (payload: { name: string; description?: string; steps: AutomationStep[] }) =>
    api.post<Automation>("/api/automations", payload),
  update: (id: string, payload: { name?: string; description?: string; steps?: AutomationStep[] }) =>
    api.patch<Automation>(`/api/automations/${id}`, payload),
  remove: (id: string) => api.delete(`/api/automations/${id}`),
  run: (automationId: string, sessionId: string) =>
    api.post<RunAutomationResult>(`/api/automations/${automationId}/run`, { sessionId }),
  runStream: runAutomationStream,
};
