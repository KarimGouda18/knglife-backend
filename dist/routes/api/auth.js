// src/routes/api/auth.ts
import { Router } from "express";
import { z } from "zod";
import { getAuth } from "../../config/firebase.js";
import { env } from "../../config/env.js";
export const apiAuthRouter = Router();
/**
 * POST /api/auth/verify-id-token
 * Body: { idToken: string }
 */
apiAuthRouter.post("/verify-id-token", async (req, res, next) => {
    try {
        const Body = z.object({ idToken: z.string().min(1) });
        const { idToken } = Body.parse(req.body);
        const decoded = await getAuth().verifyIdToken(idToken);
        return res.status(200).json({
            ok: true,
            uid: decoded.uid,
            email: decoded.email ?? null,
            claims: decoded
        });
    }
    catch (err) {
        return next(err);
    }
});
/**
 * POST /api/auth/custom-token
 * Preparata ma DISABILITATA di default (sicurezza).
 */
apiAuthRouter.post("/custom-token", async (req, res, next) => {
    try {
        if (!env.ALLOW_CUSTOM_TOKENS) {
            return res.status(403).json({ ok: false, error: "CUSTOM_TOKENS_DISABLED" });
        }
        const Body = z.object({
            uid: z.string().min(1),
            claims: z.record(z.string(), z.unknown()).optional()
        });
        const { uid, claims } = Body.parse(req.body);
        const customToken = await getAuth().createCustomToken(uid, (claims ?? undefined));
        return res.status(200).json({ ok: true, customToken });
    }
    catch (err) {
        return next(err);
    }
});
