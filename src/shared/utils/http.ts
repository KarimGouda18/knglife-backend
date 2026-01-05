// src/shared/utils/http.ts
import type { Request } from "express";

export function getBearerToken(req: Request): string | null {
  const h = req.header("authorization") ?? req.header("Authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}
