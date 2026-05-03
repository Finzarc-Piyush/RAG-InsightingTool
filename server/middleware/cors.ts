/**
 * CORS Middleware Configuration
 * Handles cross-origin resource sharing for the API
 */
import cors from "cors";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Allowed browser origins: set ALLOWED_ORIGINS=comma-separated list in production.
 * Falls back to localhost dev ports when unset (non-production only).
 */
const getAllowedOrigins = (): string[] => {
  const fromEnv = process.env.ALLOWED_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv?.length) {
    return fromEnv;
  }
  if (process.env.FRONTEND_URL?.trim()) {
    return [process.env.FRONTEND_URL.trim()];
  }
  if (!isProduction) {
    return [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "http://localhost:3002",
      "http://127.0.0.1:3002",
      "http://localhost:3003",
      "http://127.0.0.1:3003",
      "http://localhost:3004",
      "http://127.0.0.1:3004",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ];
  }
  return [];
};

const allowNoOrigin =
  !isProduction || process.env.CORS_ALLOW_NO_ORIGIN === "true";

/**
 * CORS configuration
 */
export const corsConfig = cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // In development, allow any browser Origin. Unknown Origins (e.g. Cursor embedded browser,
    // alternate dev hosts) would otherwise hit callback(Error) → next(err) → HTTP 500 from Express.
    if (!isProduction) {
      return callback(null, true);
    }

    const allowedOrigins = getAllowedOrigins();

    if (!origin) {
      if (allowNoOrigin) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS (missing Origin)"));
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn("CORS blocked origin:", origin);
    console.warn("Allowed origins:", allowedOrigins);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin",
    "Access-Control-Request-Method",
    "Access-Control-Request-Headers",
    "X-User-Email",
    "x-user-email",
    "X-User-Name",
    "x-user-name",
    "X-Internal-Api-Key",
  ],
  exposedHeaders: ["Content-Length", "X-Working-Dataset-Row-Count"],
  optionsSuccessStatus: 200,
  preflightContinue: false,
});
