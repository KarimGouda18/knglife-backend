// src/shared/middleware/requireAuth.ts
import type { Request, Response, NextFunction } from "express";
import { getBearerToken } from "../utils/http.js";
import { getAuth } from "../../config/firebase.js";
import type { AuthUser } from "../types/auth.js";

declare global {
  // eslint-disable-next-line no-var
  var __knglife_types: true;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: "MISSING_BEARER_TOKEN" });
    }

    const decoded = await getAuth().verifyIdToken(token);
    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: "INVALID_ID_TOKEN" });
  }
}
