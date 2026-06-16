/**
 * Wave API-8 · Reusable zod validation middleware for Express routes.
 *
 * `validate({ body, query, params })` returns a middleware that `safeParse`s
 * each provided part of the request. On the first failure it responds
 * `400 { error: "Invalid request", details: <zodError.flatten()> }`. On success
 * it assigns the PARSED values back onto the request (so downstream handlers
 * see coerced/defaulted output) and calls `next()`.
 *
 * ADDITIVE: routes that don't mount it are unaffected, and valid requests pass
 * through unchanged. Omitted schema parts are skipped entirely (passthrough).
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ZodSchema } from "zod";

export interface ValidateSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

export function validate(schemas: ValidateSchemas): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        res
          .status(400)
          .json({ error: "Invalid request", details: result.error.flatten() });
        return;
      }
      req.body = result.data;
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        res
          .status(400)
          .json({ error: "Invalid request", details: result.error.flatten() });
        return;
      }
      // `req.query` is a getter-only property on some Express versions; assign
      // via defineProperty-free reassignment guarded by a type cast.
      (req as { query: unknown }).query = result.data;
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        res
          .status(400)
          .json({ error: "Invalid request", details: result.error.flatten() });
        return;
      }
      (req as { params: unknown }).params = result.data;
    }

    next();
  };
}
