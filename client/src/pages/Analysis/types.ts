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

export interface AnalysisProps {
  onNavigate?: (page: 'home' | 'dashboard' | 'analysis') => void;
  onNewChat?: () => void;
  onLoadSession?: (sessionId: string, sessionData: any) => void;
  onUploadNew?: () => void;
}

