// src/shared/utils/sanitizeDeep.ts
import { sanitizeForJson } from "./text.js";
export function sanitizeDeep(value) {
    return _sanitize(value);
}
function _sanitize(v) {
    if (v === null || v === undefined)
        return v;
    if (typeof v === "string") {
        return sanitizeForJson(v);
    }
    if (Array.isArray(v)) {
        return v.map(_sanitize);
    }
    if (typeof v === "object") {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            out[k] = _sanitize(val);
        }
        return out;
    }
    return v;
}
