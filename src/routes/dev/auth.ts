// src/routes/dev/auth.ts
import { Router } from "express";
import { z } from "zod";
import { getAuth } from "../../config/firebase.js";

export const devAuthRouter = Router();

/**
 * POST /dev/auth/custom-token
 * Body: { uid: string, claims?: Record<string, unknown> }
 * Ritorna: { customToken }
 */
devAuthRouter.post("/custom-token", async (req, res, next) => {
  try {
    const Body = z.object({
      uid: z.string().min(1),
      // Zod v4: record richiede keySchema + valueSchema per essere portabile
      claims: z.record(z.string(), z.unknown()).optional()
    });

    const { uid, claims } = Body.parse(req.body);

    const auth = getAuth();
    const customToken = await auth.createCustomToken(uid, (claims ?? undefined) as any);

    return res.status(200).json({ customToken });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /dev/auth/verify-id-token
 * Body: { idToken: string }
 * Ritorna: decoded claims base
 */
devAuthRouter.post("/verify-id-token", async (req, res, next) => {
  try {
    const Body = z.object({ idToken: z.string().min(1) });
    const { idToken } = Body.parse(req.body);

    const auth = getAuth();
    const decoded = await auth.verifyIdToken(idToken);

    return res.status(200).json({
      uid: decoded.uid,
      email: decoded.email ?? null,
      firebase: decoded.firebase ?? null
    });
  } catch (err) {
    return next(err);
  }
});
