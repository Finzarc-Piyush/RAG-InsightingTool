import { API_BASE_URL } from "@/lib/config";
import { getUserEmail } from "@/utils/userStorage";
import { getAuthorizationHeader } from "@/auth/msalToken";

export interface AdminCostsSnapshot {
  generatedAt: number;
  todayDateKey: string;
  topUsersToday: Array<{
    userEmail: string;
    questionsUsed: number;
    costUsdAccumulated: number;
    tokensInputAccumulated: number;
    tokensOutputAccumulated: number;
    lastTurnAt: number;
  }>;
  recentAlerts: Array<{
    userEmail: string;
    turnId: string;
    sessionId?: string;
    costUsd: number;
    thresholdUsd: number;
    createdAt: number;
  }>;
  spendByPurposeToday: Array<{
    purpose: string;
    callCount: number;
    costUsd: number;
    tokensInput: number;
    tokensOutput: number;
  }>;
  totalsToday: {
    questions: number;
    costUsd: number;
    tokensInput: number;
    tokensOutput: number;
  };
}

/** W6.4 · GET /api/admin/costs. Throws on non-2xx so the caller can render an error state. */
export async function fetchAdminCosts(): Promise<AdminCostsSnapshot> {
  const auth = await getAuthorizationHeader();
  const userEmail = getUserEmail();
  const res = await fetch(`${API_BASE_URL}/api/admin/costs`, {
    headers: {
      ...auth,
      ...(userEmail ? { "X-User-Email": userEmail } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`admin/costs ${res.status}: ${body || res.statusText}`);
  }
  return (await res.json()) as AdminCostsSnapshot;
}

// WD9 · domain-context pack admin

export interface DomainContextPackSummary {
  id: string;
  title: string;
  category: string;
  priority: number;
  version: string;
  approxTokens: number;
  enabled: boolean;
  defaultEnabled: boolean;
}

export interface DomainContextPacksSnapshot {
  generatedAt: number;
  totalEnabledTokens: number;
  packs: DomainContextPackSummary[];
}

async function adminHeaders(): Promise<HeadersInit> {
  const auth = await getAuthorizationHeader();
  const userEmail = getUserEmail();
  return {
    ...auth,
    ...(userEmail ? { "X-User-Email": userEmail } : {}),
  };
}

export async function fetchDomainContextPacks(): Promise<DomainContextPacksSnapshot> {
  const res = await fetch(`${API_BASE_URL}/api/admin/domain-context/packs`, {
    headers: await adminHeaders(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`admin/domain-context/packs ${res.status}: ${body || res.statusText}`);
  }
  return (await res.json()) as DomainContextPacksSnapshot;
}

export async function setDomainContextPackEnabled(
  packId: string,
  enabled: boolean
): Promise<{ pack: DomainContextPackSummary; totalEnabledTokens: number }> {
  const headers = {
    ...(await adminHeaders()),
    "Content-Type": "application/json",
  };
  const res = await fetch(
    `${API_BASE_URL}/api/admin/domain-context/packs/${encodeURIComponent(packId)}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ enabled }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `admin/domain-context PATCH ${packId} ${res.status}: ${body || res.statusText}`
    );
  }
  return (await res.json()) as {
    pack: DomainContextPackSummary;
    totalEnabledTokens: number;
  };
}
