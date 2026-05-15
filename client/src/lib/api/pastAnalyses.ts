import { API_BASE_URL } from "@/lib/config";
import { getUserEmail } from "@/utils/userStorage";
import { getAuthorizationHeader } from "@/auth/msalToken";
import { logger } from "@/lib/logger";

/**
 * AMR6 · Fetch the aggregated row data for a recalled (cross-session
 * cache-hit) pivot artifact whose `storage.kind === "blob"`.
 *
 * Endpoint: `GET /api/past-analyses/:sessionId/:turnId/pivot/:artifactId`
 *
 * The session/turn pair comes from `message.recalledFromPriorAnalysis` on
 * the cache-hit assistant message. The server resolves the past_analyses
 * doc, scopes by userId, then downloads the blob and parses JSON. Inline
 * artifacts also work via this same endpoint (server inlines the rows on
 * the response) — but the client typically calls this ONLY for blob
 * artifacts since inline rows already ride on the message.
 *
 * Resolves `{rows}` on 2xx, `null` on any other status. Never throws —
 * `DataPreviewTable` surfaces an inline error / Retry UX on null.
 */

export interface RecalledPivotRowsResponse {
  artifactId: string;
  rowCount: number;
  rows: Record<string, unknown>[];
}

export async function fetchRecalledPivotRows(args: {
  originalSessionId: string;
  originalTurnId: string;
  artifactId: string;
}): Promise<RecalledPivotRowsResponse | null> {
  try {
    const auth = await getAuthorizationHeader();
    const userEmail = getUserEmail();
    const url = `${API_BASE_URL}/api/past-analyses/${encodeURIComponent(
      args.originalSessionId
    )}/${encodeURIComponent(args.originalTurnId)}/pivot/${encodeURIComponent(
      args.artifactId
    )}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...auth,
        ...(userEmail ? { "X-User-Email": userEmail } : {}),
      },
    });
    if (!res.ok) {
      logger.warn(
        `fetchRecalledPivotRows failed (${res.status}) for artifact ${args.artifactId}`
      );
      return null;
    }
    const body = (await res.json()) as RecalledPivotRowsResponse;
    if (!Array.isArray(body?.rows)) return null;
    return body;
  } catch (err) {
    logger.warn(
      `fetchRecalledPivotRows threw: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
