/**
 * Type definitions for Analysis page components
 */

export interface Session {
  id: string;
  username: string;
  fileName: string;
  uploadedAt: number;
  createdAt: number;
  lastUpdatedAt: number;
  messageCount: number;
  chartCount: number;
  sessionId: string;
  collaborators?: string[];
  /** Sidebar pin flag — pinned sessions sort to the top. */
  pinned?: boolean;
  /** Timestamp (ms) when `pinned` was set true. */
  pinnedAt?: number;
}

export interface SessionsResponse {
  sessions: Session[];
  count: number;
  message: string;
}

/**
 * Shape of the per-session detail object App primes into Home as
 * `loadedSessionData`. It is set from the session-detail fetch
 * (`sessionsApi.getSessionDetails`) and from sidebar `onLoadSession`
 * callbacks, and is read as EITHER a wrapper `{ session: <meta> }` OR the
 * session meta object itself (`loadedSessionData?.session ?? loadedSessionData`).
 *
 * Only the fields actually read in App/Home are modelled here; the index
 * signature keeps it permissive for the many further fields consumed by
 * `useSessionLoader` (charts, messages, dataSummary, enrichmentStatus, …)
 * without coupling this type to that hook's internals.
 */
export interface LoadedSessionMeta extends Partial<Session> {
  /** Permanent (per-session) context string read by Home's context modal. */
  permanentContext?: string;
  [key: string]: unknown;
}

export interface LoadedSessionData {
  /** Present when the payload wraps the session meta (detail-fetch shape). */
  session?: LoadedSessionMeta;
  /** Permanent context may also sit at the top level (bare-session shape). */
  permanentContext?: string;
  [key: string]: unknown;
}

export interface AnalysisProps {
  onNavigate?: (page: 'home' | 'dashboard' | 'analysis') => void;
  onNewChat?: () => void;
  onLoadSession?: (sessionId: string, sessionData: any) => void;
  onUploadNew?: () => void;
}

