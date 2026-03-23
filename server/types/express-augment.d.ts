import type { JwtPayload } from "jsonwebtoken";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        email: string;
        oid?: string;
        claims: JwtPayload;
      };
    }
  }
}

export {};
