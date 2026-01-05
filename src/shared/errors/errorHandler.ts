// src/shared/errors/errorHandler.ts
import type { Request, Response, NextFunction } from "express";

function safeErrorToString(err: unknown): string {
  try {
    if (err instanceof Error) {
      return err.stack ?? err.message;
    }
    if (typeof err === "string") return err;
    return JSON.stringify(err);
  } catch {
    // fallback ultra-sicuro
    return Object.prototype.toString.call(err);
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // Non passiamo oggetti “strani” direttamente a console.error su Node 24.
  // Usiamo una stringa safe.
  // eslint-disable-next-line no-console
  console.error("[knglife] error:", safeErrorToString(err));

  // Zod error (supporta sia v3 che v4 senza dipendere da proprietà interne)
  const maybeZod = err as any;
  if (maybeZod && typeof maybeZod === "object" && Array.isArray(maybeZod.issues)) {
    return res.status(400).json({ ok: false, error: "BAD_REQUEST", details: maybeZod.issues });
  }

  return res.status(500).json({ ok: false, error: "INTERNAL_SERVER_ERROR" });
}
