// src/shared/errors/errorHandler.ts
import type { ErrorRequestHandler } from "express";
import { env } from "../../config/env.js";

function isProd() {
  // Se hai un env diverso (es. env.NODE_ENV), adattalo qui.
  // Con la tua codebase, env è validato da zod in config/env.ts.
  // In caso non ci sia NODE_ENV in env, usa process.env.NODE_ENV.
  const nodeEnv = (process.env.NODE_ENV ?? "").toLowerCase();
  return nodeEnv === "production";
}

function safeString(v: unknown) {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return String(v);
  } catch {
    return "";
  }
}

function pickErrorCode(err: any) {
  // Firestore/Admin SDK spesso mette code come stringa o numero
  return err?.code ?? err?.status ?? err?.statusCode ?? null;
}

function pickErrorMessage(err: any) {
  return err?.message ?? err?.error?.message ?? "INTERNAL_SERVER_ERROR";
}

function pickErrorStack(err: any) {
  return err?.stack ?? null;
}

function pickErrorDetails(err: any) {
  // Alcuni errori Google APIs includono details/metadata
  const details = err?.details ?? err?.error?.details ?? err?.response?.data ?? null;
  return details ?? null;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const code = pickErrorCode(err);
  const message = pickErrorMessage(err);

  // Log server-side SEMPRE (utile anche in prod), ma senza secrets.
  // eslint-disable-next-line no-console
  console.error(
    "[error]",
    {
      method: req.method,
      path: req.originalUrl,
      code,
      message: safeString(message)
    },
    // stack in console (molto utile)
    pickErrorStack(err)
  );

  const status =
    typeof err?.statusCode === "number"
      ? err.statusCode
      : typeof err?.status === "number"
        ? err.status
        : 500;

  return res.status(status).json({
    ok: false,
    error: status === 404 ? "NOT_FOUND" : safeString(message),
    status,
    code,
    stack: pickErrorStack(err),
    details: pickErrorDetails(err)
  });
};