// src/routes/api/me.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../shared/middleware/requireAuth.js";
import { getFirestore } from "../../config/firebase.js";
import { getOrCreateUserProfile, updateUserProfile } from "../../modules/users/userRepo.js";

export const apiMeRouter = Router();

apiMeRouter.use(requireAuth);

apiMeRouter.get("/", async (req, res, next) => {
  try {
    const uid = req.user!.uid;
    const email = req.user!.email ?? null;

    const db = getFirestore();
    const profile = await getOrCreateUserProfile(db, uid, email);

    return res.status(200).json({ ok: true, profile });
  } catch (err) {
    return next(err);
  }
});

apiMeRouter.put("/", async (req, res, next) => {
  try {
    const uid = req.user!.uid;
    const db = getFirestore();

    const Body = z.object({
      name: z.string().max(80).optional(),
      surname: z.string().max(80).optional(),

      // ISO date: "YYYY-MM-DD"
      birthDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),

      gender: z.string().max(40).nullable().optional(),
      visualDisabilityLevel: z.enum(["none", "low_vision", "blind", "other"]).optional(),
      photoURL: z.string().url().nullable().optional(),
      bio: z.string().max(5000).optional(),
      nsfwEnabled: z.boolean().optional()
    });

    const patch = Body.parse(req.body);
    const profile = await updateUserProfile(db, uid, patch);

    return res.status(200).json({ ok: true, profile });
  } catch (err) {
    return next(err);
  }
});
