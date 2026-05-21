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

/**
 * Wave W61-detail-schema · projected dataset column shape (matches the
 * server's `AdminSemanticModelDatasetColumn`). Declared client-side
 * rather than imported across the runtime boundary per the W61
 * cross-runtime-boundary local-interface-mirror convention; runtime
 * drift surfaces as field-undefined at the call site rather than
 * compile errors.
 */
export interface AdminSemanticModelDatasetColumn {
  name: string;
  type: string;
}

/**
 * Wave W61-detail-schema · the dataset's column inventory at admin
 * read time (mirrors server's `AdminSemanticModelDatasetSchema`).
 */
export interface AdminSemanticModelDatasetSchema {
  columns: AdminSemanticModelDatasetColumn[];
}

export interface AdminSemanticModelDetail {
  sessionId: string;
  fileName: string;
  username: string;
  lastUpdatedAt: number;
  model: import("@/shared/schema").SemanticModel;
  /**
   * Wave W61-detail-schema · the session's live dataset columns,
   * populated from `doc.dataSummary?.columns` server-side. `null`
   * when the doc has no `dataSummary` OR when its `columns` array is
   * empty — consumers (column-picker, references tag-input) should
   * fall back to free-text edit when null.
   */
  datasetSchema: AdminSemanticModelDatasetSchema | null;
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

// W61-delete-client (widened by W61-references-dashboards) · response
// envelope from GET /api/admin/semantic-models/:sessionId/references?entry=<name>.
// Mirrors the server's `AdminSemanticModelReferencesResponse`.
//
// `entry` is the server-trimmed value (e.g. `?entry=%20foo%20` arrives
// as `" foo "` and is echoed as `"foo"`) — the modal compares this
// against its local entry state to detect a stale fetch (admin clicked
// Cancel + re-opened on a different entry while the first round-trip
// was still in flight).
//
// `dashboardCount` + `dashboardTileCount` were added by the
// W61-references-dashboards wave so the delete-confirmation copy can
// surface the cross-dashboard impact ("and M tiles across K dashboards")
// alongside the in-chat chart impact. Both are zero on sessions whose
// owner has authored no dashboards that reference the entry.
export interface AdminSemanticModelReferencesResponse {
  sessionId: string;
  entry: string;
  chartCount: number;
  totalOccurrences: number;
  dashboardCount: number;
  dashboardTileCount: number;
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

// W61-add-client · typed error for the W61-add-server 409 response.
// The server returns `{ error: "name_already_exists", sessionId, kind,
// name }` when the request collides with an existing entry; the host
// uses `err instanceof NameAlreadyExistsError` to render a typed inline
// error rather than scraping `err.message`.
//
// Generic non-2xx responses still bubble as plain `Error` per the
// existing helper convention.
export class NameAlreadyExistsError extends Error {
  readonly kind: AdminSemanticModelEntryKind;
  readonly entryName: string;
  constructor(kind: AdminSemanticModelEntryKind, entryName: string) {
    super(`A ${kind} named "${entryName}" already exists in this session.`);
    this.name = "NameAlreadyExistsError";
    this.kind = kind;
    this.entryName = entryName;
  }
}

// W61-add-client · POST /api/admin/semantic-models/:sessionId/entries/:kind.
// Body: a single new entry validated server-side by the kind-appropriate
// zod schema (semanticMetricSchema / semanticDimensionSchema /
// semanticHierarchySchema). Returns the W61-save envelope on 200 so the
// host's success handler can reuse the existing `setData` shape.
//
// **409 handling**: the server returns `{ error: "name_already_exists",
// sessionId, kind, name }` when the new entry's name collides with an
// existing entry of the same kind. This helper parses that body and
// throws `NameAlreadyExistsError` so the host can `instanceof`-test and
// render an inline collision message under the name field.
//
// Cross-kind collisions are allowed server-side (a metric "x" and a
// dimension "x" coexist) — the 409 only fires for same-kind collisions.
//
// The entry parameter is typed as the union of the three semantic-model
// entry types; the server validates the actual shape per :kind.
export async function addSemanticModelEntry(
  sessionId: string,
  kind: AdminSemanticModelEntryKind,
  entry:
    | import("@/shared/schema").SemanticMetric
    | import("@/shared/schema").SemanticDimension
    | import("@/shared/schema").SemanticHierarchy,
): Promise<PatchSemanticModelResponse> {
  const url =
    `${API_BASE_URL}/api/admin/semantic-models/${encodeURIComponent(sessionId)}` +
    `/entries/${encodeURIComponent(kind)}`;
  const headers = {
    ...(await adminHeaders()),
    "Content-Type": "application/json",
  };
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(entry),
  });
  if (res.status === 409) {
    // Parse the typed 409 envelope so the host can branch on the
    // collision shape. If the body isn't the expected shape (server
    // version mismatch, proxy injecting HTML, etc.) fall through to
    // the generic-Error branch so the host still surfaces the failure.
    const body = (await res.json().catch(() => null)) as
      | { error?: string; kind?: AdminSemanticModelEntryKind; name?: string }
      | null;
    if (
      body &&
      body.error === "name_already_exists" &&
      typeof body.name === "string" &&
      (body.kind === "metric" ||
        body.kind === "dimension" ||
        body.kind === "hierarchy")
    ) {
      throw new NameAlreadyExistsError(body.kind, body.name);
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `admin/semantic-models/${sessionId}/entries/${kind} POST ${res.status}: ${body || res.statusText}`,
    );
  }
  return (await res.json()) as PatchSemanticModelResponse;
}
