// src/shared/errors/errorHandler.ts
import type { Request, Response, NextFunction } from "express";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // eslint-disable-next-line no-console
  console.error("[knglife] error:", err);

  // Zod & altri errori “safe”
  if (err && typeof err === "object" && "name" in err && (err as any).name === "ZodError") {
    return res.status(400).json({ ok: false, error: "BAD_REQUEST", details: (err as any).issues });
  }

  return res.status(500).json({ ok: false, error: "INTERNAL_SERVER_ERROR" });
}
