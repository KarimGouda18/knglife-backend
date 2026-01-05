// src/shared/errors/notFound.ts
import type { Request, Response, NextFunction } from "express";

export function notFoundHandler(req: Request, res: Response, _next: NextFunction) {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND",
    path: req.path
  });
}
