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

// W61-list · admin semantic-model index. Lists every session whose
// ChatDocument.semanticModel is defined; the AdminSemanticModels page
// renders this as a table of clickable rows.

export interface AdminSemanticModelListEntry {
  id: string;
  username: string;
  fileName: string;
  sessionId: string;
  lastUpdatedAt: number;
  version: number;
  modelName: string;
  modelUpdatedAt?: string;
  modelUpdatedBy?: string;
  metricsCount: number;
  dimensionsCount: number;
  hierarchiesCount: number;
}

export interface AdminSemanticModelListSnapshot {
  generatedAt: number;
  sessions: AdminSemanticModelListEntry[];
}

export async function fetchSemanticModels(): Promise<AdminSemanticModelListSnapshot> {
  const res = await fetch(`${API_BASE_URL}/api/admin/semantic-models`, {
    headers: await adminHeaders(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `admin/semantic-models ${res.status}: ${body || res.statusText}`,
    );
  }
  return (await res.json()) as AdminSemanticModelListSnapshot;
}

// W61-detail · per-session semantic-model payload for the read-only viewer.

export interface AdminSemanticModelDetail {
  sessionId: string;
  fileName: string;
  username: string;
  lastUpdatedAt: number;
  model: import("@/shared/schema").SemanticModel;
}

export async function fetchSemanticModelDetail(
  sessionId: string,
): Promise<AdminSemanticModelDetail> {
  const res = await fetch(
    `${API_BASE_URL}/api/admin/semantic-models/${encodeURIComponent(sessionId)}`,
    { headers: await adminHeaders() },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `admin/semantic-models/${sessionId} ${res.status}: ${body || res.statusText}`,
    );
  }
  return (await res.json()) as AdminSemanticModelDetail;
}

// W61-save · replace a session's semantic model. The server bumps
// version + stamps updatedAt/updatedBy server-side; the response
// echoes the server's authoritative view so the client can sync.

export interface PatchSemanticModelResponse {
  sessionId: string;
  lastUpdatedAt: number;
  model: import("@/shared/schema").SemanticModel;
}

export async function patchSemanticModel(
  sessionId: string,
  model: import("@/shared/schema").SemanticModel,
): Promise<PatchSemanticModelResponse> {
  const headers = {
    ...(await adminHeaders()),
    "Content-Type": "application/json",
  };
  const res = await fetch(
    `${API_BASE_URL}/api/admin/semantic-models/${encodeURIComponent(sessionId)}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify(model),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `admin/semantic-models/${sessionId} PATCH ${res.status}: ${body || res.statusText}`,
    );
  }
  return (await res.json()) as PatchSemanticModelResponse;
}

// W61-audit-history-client · client mirror of the server's
// SemanticModelAuditEntry. Lives client-side because the server module
// (`server/lib/semantic/semanticModelAuditLog.ts`) is across the
// runtime boundary; a runtime drift between this mirror and the server
// surfaces as field-undefined access at the TanStack Query call site.
// Mirrors the W61-detail / W61-save inline-import pattern for
// SemanticModel.
export interface AdminSemanticModelAuditEntry {
  savedAt: number;
  savedBy: string;
  priorVersion: number;
  priorModel: import("@/shared/schema").SemanticModel;
}

export interface AdminSemanticModelAuditLog {
  sessionId: string;
  entries: AdminSemanticModelAuditEntry[];
}

// W61-audit-history-client · GET /api/admin/semantic-models/:sessionId/audit-log
export async function fetchSemanticModelAuditLog(
  sessionId: string,
): Promise<AdminSemanticModelAuditLog> {
  const res = await fetch(
    `${API_BASE_URL}/api/admin/semantic-models/${encodeURIComponent(sessionId)}/audit-log`,
    { headers: await adminHeaders() },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `admin/semantic-models/${sessionId}/audit-log ${res.status}: ${body || res.statusText}`,
    );
  }
  return (await res.json()) as AdminSemanticModelAuditLog;
}

// W61-audit-history-client · POST /api/admin/semantic-models/:sessionId/revert
// Re-uses PatchSemanticModelResponse because the server envelope
// (`{ sessionId, lastUpdatedAt, model }`) is byte-identical to the
// W61-save response — the future history-tab UI's revert mutation can
// reuse the same success handler shape as the existing edit mutation.
export async function revertSemanticModel(
  sessionId: string,
  auditEntryIndex: number,
): Promise<PatchSemanticModelResponse> {
  const headers = {
    ...(await adminHeaders()),
    "Content-Type": "application/json",
  };
  const res = await fetch(
    `${API_BASE_URL}/api/admin/semantic-models/${encodeURIComponent(sessionId)}/revert`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ auditEntryIndex }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `admin/semantic-models/${sessionId}/revert ${res.status}: ${body || res.statusText}`,
    );
  }
  return (await res.json()) as PatchSemanticModelResponse;
}

// W61-delete-client · the three entry kinds the admin can delete. Local
// mirror of the server's `AdminSemanticModelEntryKind` exported from
// `server/controllers/adminSemanticModelController.ts`; we don't import
// across the runtime boundary (per the W61 cross-runtime-boundary
// convention — runtime drift surfaces as field-undefined access at the
// call site rather than compile errors, and the literal-union shape is
// small / stable).
export type AdminSemanticModelEntryKind = "metric" | "dimension" | "hierarchy";

// W61-delete-client · response envelope from
// GET /api/admin/semantic-models/:sessionId/references?entry=<name>.
// Mirrors the server's `AdminSemanticModelReferencesResponse`.
//
// `entry` is the server-trimmed value (e.g. `?entry=%20foo%20` arrives
// as `" foo "` and is echoed as `"foo"`) — the modal compares this
// against its local entry state to detect a stale fetch (admin clicked
// Cancel + re-opened on a different entry while the first round-trip
// was still in flight).
export interface AdminSemanticModelReferencesResponse {
  sessionId: string;
  entry: string;
  chartCount: number;
  totalOccurrences: number;
}

export async function fetchSemanticModelReferences(
  sessionId: string,
  entry: string,
): Promise<AdminSemanticModelReferencesResponse> {
  const url =
    `${API_BASE_URL}/api/admin/semantic-models/${encodeURIComponent(sessionId)}/references` +
    `?entry=${encodeURIComponent(entry)}`;
  const res = await fetch(url, { headers: await adminHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `admin/semantic-models/${sessionId}/references ${res.status}: ${body || res.statusText}`,
    );
  }
  return (await res.json()) as AdminSemanticModelReferencesResponse;
}

// W61-delete-client · DELETE /api/admin/semantic-models/:sessionId/entries/:kind/:name.
// Re-uses `PatchSemanticModelResponse` because the server delete
// endpoint returns the W61-save envelope (`{ sessionId, lastUpdatedAt,
// model }`) byte-identical to PATCH / revert (per the W61 envelope-
// reuse convention) — the host component can pipe the response into
// the same `setData` shape it uses for PATCH success and revert
// success, so the audit-history Card's `lastUpdatedAt` re-fetch effect
// fires automatically.
export async function deleteSemanticModelEntry(
  sessionId: string,
  kind: AdminSemanticModelEntryKind,
  name: string,
): Promise<PatchSemanticModelResponse> {
  const url =
    `${API_BASE_URL}/api/admin/semantic-models/${encodeURIComponent(sessionId)}` +
    `/entries/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: await adminHeaders(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `admin/semantic-models/${sessionId}/entries/${kind}/${name} DELETE ${res.status}: ${body || res.statusText}`,
    );
  }
  return (await res.json()) as PatchSemanticModelResponse;
}
