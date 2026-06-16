/**
 * OBS-6 · POST /api/client-error — a real client error sink.
 *
 * The client's `reportClientError` (errorSink.ts) POSTs uncaught browser errors
 * here so they reach the structured server logs instead of dying in the browser
 * console. Wired from the React `ErrorBoundary` and the global window
 * `error` / `unhandledrejection` listeners in `main.tsx`.
 *
 * This route lives under `/api`, which is already auth-gated by
 * `requireAzureAdAuth` (see `server/index.ts`), so unauthenticated traffic never
 * reaches it. We log at WARN — a client-side crash is a signal worth surfacing,
 * but it's recoverable and noisy, so it should not page as an `error`.
 *
 * PII contract: the body carries no PII GUARANTEES (a stack frame could embed
 * arbitrary strings), so we CAP the stack length defensively before it hits the
 * logs, and validate the body shape with a strict zod schema. The endpoint
 * returns 204 (the client treats it fire-and-forget either way).
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { logger } from "../lib/logger.js";

const router = Router();

// Defensive caps — a client stack/message has no PII guarantees and no bounded
// length, so we truncate before logging. Mirrors the client-side caps.
const MAX_STACK_LEN = 4000;
const MAX_MESSAGE_LEN = 1000;
const MAX_FIELD_LEN = 512;

export const clientErrorRequestSchema = z
  .object({
    message: z.string().min(1).max(MAX_MESSAGE_LEN * 4),
    stack: z.string().max(MAX_STACK_LEN * 4).optional(),
    source: z.string().max(MAX_FIELD_LEN).optional(),
    route: z.string().max(MAX_FIELD_LEN).optional(),
    correlationId: z.string().max(MAX_FIELD_LEN).optional(),
  })
  .strict();

export type ClientErrorRequest = z.infer<typeof clientErrorRequestSchema>;

function cap(value: string | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

export function clientErrorController(req: Request, res: Response): Response {
  const parsed = clientErrorRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body.",
      details: parsed.error.flatten(),
    });
  }

  const { message, stack, source, route, correlationId } = parsed.data;

  logger.warn("client-error", {
    message: cap(message, MAX_MESSAGE_LEN),
    ...(stack ? { stack: cap(stack, MAX_STACK_LEN) } : {}),
    ...(source ? { source } : {}),
    ...(route ? { route } : {}),
    ...(correlationId ? { correlationId } : {}),
  });

  return res.status(204).send();
}

router.post("/client-error", clientErrorController);

export default router;
