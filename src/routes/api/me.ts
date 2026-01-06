// src/routes/api/me.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../shared/middleware/requireAuth.js";
import { getFirestore } from "../../config/firebase.js";
import { getOrCreateUserProfile, isProfileCompleted, updateUserProfile } from "../../modules/users/userRepo.js";
import { computeAgeFromBirthDate } from "../../shared/utils/safety.js";
import { apiMeInterviewRouter } from "./meInterview.js";

export const apiMeRouter = Router();
apiMeRouter.use(requireAuth);

function isAdult(birthDate: string | null) {
  const age = computeAgeFromBirthDate(birthDate);
  return typeof age === "number" && age >= 18;
}

apiMeRouter.get("/", async (req, res, next) => {
  try {
    const uid = req.user!.uid;
    const email = req.user!.email ?? null;

    const db = getFirestore();
    const profile = await getOrCreateUserProfile(db, uid, email);

    return res.status(200).json({
      ok: true,
      profile,
      profileCompleted: isProfileCompleted(profile),
      onboardingCompleted: profile.onboardingCompleted
    });
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
      surname: z.string().max(120).optional(),

      birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),

      gender: z.string().max(40).nullable().optional(),
      visualDisabilityLevel: z.enum(["none", "low_vision", "blind", "other"]).optional(),
      photoURL: z.string().url().nullable().optional(),
      bio: z.string().max(8000).optional(),
      nsfwEnabled: z.boolean().optional(),

      // opzionale: se vuoi marcare onboarding completato manualmente (di default lo settiamo a fine intervista)
      onboardingCompleted: z.boolean().optional()
    });

    const patch = Body.parse(req.body);

    const current = await getOrCreateUserProfile(db, uid, req.user!.email ?? null);

    const effectiveBirthDate = (patch.birthDate !== undefined ? patch.birthDate : current.birthDate) ?? null;
    const adult = isAdult(effectiveBirthDate);

    if (!adult && patch.nsfwEnabled === true) {
      return res.status(403).json({ ok: false, error: "NSFW_NOT_ALLOWED_FOR_USER" });
    }

    if (!adult && current.nsfwEnabled) {
      patch.nsfwEnabled = false;
    }

    const profile = await updateUserProfile(db, uid, patch);

    return res.status(200).json({
      ok: true,
      profile,
      profileCompleted: isProfileCompleted(profile),
      onboardingCompleted: profile.onboardingCompleted
    });
  } catch (err) {
    return next(err);
  }
});

// Mount interview sotto /api/me/interview/*
apiMeRouter.use("/interview", apiMeInterviewRouter);
