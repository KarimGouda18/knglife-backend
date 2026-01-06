// src/shared/utils/sanitizeDeep.ts
import { sanitizeForJson } from "./text.js";

export function sanitizeDeep<T>(value: T): T {
  return _sanitize(value) as T;
}

function _sanitize(v: any): any {
  if (v === null || v === undefined) return v;

  if (typeof v === "string") {
    return sanitizeForJson(v);
  }

  if (Array.isArray(v)) {
    return v.map(_sanitize);
  }

  if (typeof v === "object") {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = _sanitize(val);
    }
    return out;
  }

  return v;
}
