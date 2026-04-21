/**
 * P-029: Zod schemas for Python-service response shapes.
 *
 * Mirrors the FastAPI pydantic models in python-service/main.py. Call sites
 * that want runtime shape-safety use parsePythonResponse() below; others
 * continue to cast for backward compatibility during the rollout.
 *
 * Keep these in sync with python-service/main.py — the CI python job runs
 * `python -c "import main"` but does not currently enforce schema equality,
 * so treat any new endpoint here as a documentation contract.
 */
import { z } from "zod";

export class PythonServiceShapeError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly zodMessage: string
  ) {
    super(
      `Python service ${endpoint} returned an unexpected shape: ${zodMessage}`
    );
    this.name = "PythonServiceShapeError";
  }
}

const rowRecord = z.record(z.unknown());

export const previewResponseSchema = z.object({
  data: z.array(rowRecord),
  total_rows: z.number(),
  returned_rows: z.number(),
});

export const summaryResponseSchema = z.object({
  summary: z.array(
    z.object({
      variable: z.string(),
      datatype: z.string(),
    }).passthrough()
  ),
}).passthrough();

export const aggregateResponseSchema = z.object({
  data: z.array(rowRecord),
  rows_before: z.number(),
  rows_after: z.number(),
  warnings: z
    .array(
      z.object({
        column: z.string(),
        droppedCount: z.number(),
        message: z.string(),
      }).passthrough()
    )
    .optional(),
}).passthrough();

export const removeNullsResponseSchema = z.object({
  data: z.array(rowRecord),
  rows_before: z.number(),
  rows_after: z.number(),
  nulls_removed: z.number(),
}).passthrough();

/**
 * Parse a Python-service response against a Zod schema. Throws
 * PythonServiceShapeError on mismatch so the Node side can recover cleanly
 * instead of crashing deep in a consumer.
 */
export function parsePythonResponse<T>(
  endpoint: string,
  schema: z.ZodType<T>,
  raw: unknown
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new PythonServiceShapeError(endpoint, parsed.error.message);
  }
  return parsed.data;
}
