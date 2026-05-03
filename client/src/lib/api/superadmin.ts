import { API_BASE_URL } from "@/lib/config";
import { getAuthorizationHeader } from "@/auth/msalToken";
import { getUserEmail } from "@/utils/userStorage";

export interface SuperadminMeResponse {
  isSuperadmin: boolean;
  email: string | null;
}

/**
 * GET /api/superadmin/me — single bit the navbar uses to decide whether to
 * render the Admin View entry. Always returns 200 with `isSuperadmin: false`
 * for non-allowlist users; the client never has to handle 403 specially.
 */
export async function fetchSuperadminMe(): Promise<SuperadminMeResponse> {
  const auth = await getAuthorizationHeader();
  const userEmail = getUserEmail();
  const res = await fetch(`${API_BASE_URL}/api/superadmin/me`, {
    method: "GET",
    headers: {
      ...auth,
      ...(userEmail ? { "X-User-Email": userEmail } : {}),
    },
  });
  if (!res.ok) {
    return { isSuperadmin: false, email: userEmail };
  }
  return (await res.json()) as SuperadminMeResponse;
}

export interface SuperadminSessionRow {
  sessionId: string;
  ownerEmail: string;
  fileName: string | null;
  createdAt: string | null;
  lastUpdatedAt: string | null;
  messageCount: number;
  chartCount: number;
  feedbackCounts: { up: number; down: number; none: number };
  hasDashboards: boolean;
}

export async function fetchSuperadminSessions(): Promise<SuperadminSessionRow[]> {
  const auth = await getAuthorizationHeader();
  const userEmail = getUserEmail();
  const res = await fetch(`${API_BASE_URL}/api/superadmin/sessions`, {
    method: "GET",
    headers: {
      ...auth,
      ...(userEmail ? { "X-User-Email": userEmail } : {}),
    },
  });
  if (!res.ok) throw new Error(`superadmin sessions failed (${res.status})`);
  const body = (await res.json()) as { sessions: SuperadminSessionRow[] };
  return body.sessions ?? [];
}

export interface SuperadminDashboardRow {
  dashboardId: string;
  ownerEmail: string;
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export async function fetchSuperadminDashboards(): Promise<SuperadminDashboardRow[]> {
  const auth = await getAuthorizationHeader();
  const userEmail = getUserEmail();
  const res = await fetch(`${API_BASE_URL}/api/superadmin/dashboards`, {
    method: "GET",
    headers: {
      ...auth,
      ...(userEmail ? { "X-User-Email": userEmail } : {}),
    },
  });
  if (!res.ok) throw new Error(`superadmin dashboards failed (${res.status})`);
  const body = (await res.json()) as { dashboards: SuperadminDashboardRow[] };
  return body.dashboards ?? [];
}
