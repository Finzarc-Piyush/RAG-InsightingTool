/**
 * Read-only chat viewer for superadmins. Loads any session by id (bypassing
 * the collaborator check on the server) and renders the message stream with
 * feedback widgets disabled — the admin can see what was thumbed up/down,
 * but cannot interact.
 *
 * Deliberately does NOT reuse the full `Home` page surface (regenerate, edit,
 * input composer, dashboard auto-create are all owner-only). The render here
 * is purpose-built: role-tagged bubbles, markdown content, and disabled
 * `FeedbackButtons` (answer + per-spawned-question + pivot) so the admin can
 * scan feedback at a glance.
 */

import { useEffect, useMemo } from "react";
import { useLocation, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useSuperadmin } from "@/auth/useSuperadmin";
import { API_BASE_URL } from "@/lib/config";
import { getAuthorizationHeader } from "@/auth/msalToken";
import { getUserEmail } from "@/utils/userStorage";
import { Card } from "@/components/ui/card";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { FeedbackButtons } from "@/pages/Home/Components/FeedbackButtons";
import { ShadowBanner } from "./ShadowBanner";
import type { Message } from "@/shared/schema";

interface SuperadminSession {
  sessionId: string;
  username: string;
  fileName?: string | null;
  messages: Message[];
}

async function fetchSuperadminSession(
  sessionId: string
): Promise<SuperadminSession> {
  const auth = await getAuthorizationHeader();
  const userEmail = getUserEmail();
  const res = await fetch(
    `${API_BASE_URL}/api/superadmin/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "GET",
      headers: {
        ...auth,
        ...(userEmail ? { "X-User-Email": userEmail } : {}),
      },
    }
  );
  if (!res.ok) throw new Error(`fetch session ${sessionId} failed (${res.status})`);
  const body = (await res.json()) as { session: SuperadminSession };
  return body.session;
}

export default function SuperadminSessionViewer() {
  const { isSuperadmin, isLoading: isAuthLoading } = useSuperadmin();
  const [, params] = useRoute<{ sessionId: string }>(
    "/superadmin/sessions/:sessionId"
  );
  const [, setLocation] = useLocation();
  const sessionId = params?.sessionId ?? null;

  useEffect(() => {
    if (!isAuthLoading && !isSuperadmin) setLocation("/analysis");
  }, [isAuthLoading, isSuperadmin, setLocation]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["superadmin", "session", sessionId],
    queryFn: () => fetchSuperadminSession(sessionId!),
    enabled: isSuperadmin && !!sessionId,
    staleTime: 30 * 1000,
  });

  const messages = useMemo<Message[]>(() => data?.messages ?? [], [data]);

  if (isAuthLoading || !isSuperadmin || !sessionId) return null;

  return (
    <div className="min-h-screen flex flex-col">
      <ShadowBanner ownerEmail={data?.username ?? null} />
      <div className="container mx-auto py-4 px-4 sm:px-6 max-w-4xl flex-1">
        <div className="mb-4 text-xs text-muted-foreground">
          Dataset:{" "}
          <span className="text-foreground font-medium">
            {data?.fileName ?? "—"}
          </span>
        </div>

        {error ? (
          <Card className="p-6 border-destructive/40 bg-destructive/5">
            <p className="text-sm text-destructive">
              Couldn't load this session. The id may be invalid or the request
              failed.
            </p>
          </Card>
        ) : isLoading ? (
          <Card className="p-6 border-border/60 bg-card">
            <p className="text-sm text-muted-foreground">Loading session…</p>
          </Card>
        ) : messages.length === 0 ? (
          <Card className="p-6 border-border/60 bg-card">
            <p className="text-sm text-muted-foreground">
              This session has no messages yet.
            </p>
          </Card>
        ) : (
          <div className="space-y-4">
            {messages.map((msg, idx) => (
              <ShadowMessage
                key={idx}
                message={msg}
                sessionId={sessionId}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ShadowMessage({
  message,
  sessionId,
}: {
  message: Message;
  sessionId: string;
}) {
  const isUser = message.role === "user";
  const turnId = (
    message.agentTrace as { turnId?: string } | undefined
  )?.turnId;
  const feedbackDetails = (
    message as Message & {
      feedbackDetails?: Array<{
        target: { type: "answer" | "subanswer" | "pivot"; id: string };
        feedback: "up" | "down" | "none";
        comment?: string | null;
      }>;
    }
  ).feedbackDetails;

  const answerFeedback =
    feedbackDetails?.find((d) => d.target.type === "answer") ?? null;
  const pivotFeedback =
    feedbackDetails?.find((d) => d.target.type === "pivot") ?? null;
  const subanswerByQuestionId = new Map<
    string,
    { feedback: "up" | "down" | "none"; comment?: string | null }
  >();
  for (const d of feedbackDetails ?? []) {
    if (d.target.type === "subanswer") {
      subanswerByQuestionId.set(d.target.id, {
        feedback: d.feedback,
        comment: d.comment,
      });
    }
  }

  const spawned = (
    message as Message & { spawnedQuestions?: { id: string; question: string }[] }
  ).spawnedQuestions;

  return (
    <Card
      className={
        isUser
          ? "p-4 border-primary/30 bg-primary/5"
          : "p-4 border-border/60 bg-card"
      }
    >
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
        {isUser ? "User" : "Assistant"}
      </div>
      <div className="text-sm text-foreground">
        <MarkdownRenderer content={message.content ?? ""} />
      </div>

      {!isUser && spawned && spawned.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Spawned sub-questions
          </div>
          {spawned.map((q) => {
            const fb = subanswerByQuestionId.get(q.id);
            return (
              <div
                key={q.id}
                className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-foreground/80"
              >
                <span className="flex-1 min-w-0">{q.question}</span>
                {turnId && (
                  <FeedbackButtons
                    sessionId={sessionId}
                    turnId={turnId}
                    target={{ type: "subanswer", id: q.id }}
                    layout="inline-right"
                    disabled
                    initial={fb?.feedback ?? "none"}
                    initialComment={fb?.comment ?? ""}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {!isUser && turnId && (
        <div className="mt-3 flex items-center gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Answer feedback
          </span>
          <FeedbackButtons
            sessionId={sessionId}
            turnId={turnId}
            target={{ type: "answer", id: "answer" }}
            layout="inline-right"
            disabled
            initial={answerFeedback?.feedback ?? "none"}
            initialComment={answerFeedback?.comment ?? ""}
          />
          {pivotFeedback && (
            <>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground ml-2">
                Pivot
              </span>
              <FeedbackButtons
                sessionId={sessionId}
                turnId={turnId}
                target={{ type: "pivot", id: "pivot" }}
                layout="inline-right"
                disabled
                initial={pivotFeedback.feedback}
                initialComment={pivotFeedback.comment ?? ""}
              />
            </>
          )}
        </div>
      )}
    </Card>
  );
}
