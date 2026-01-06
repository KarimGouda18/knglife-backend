// src/routes/api/community.ts
import { Router } from "express";
import { requireAuth } from "../../shared/middleware/requireAuth.js";
import { getFirestore } from "../../config/firebase.js";
import { getOrCreateUserProfile } from "../../modules/users/userRepo.js";
import { getAssistant, listPublicAssistants } from "../../modules/assistants/assistantsRepo.js";
import { computeAgeFromBirthDate } from "../../shared/utils/safety.js";

export const apiCommunityRouter = Router();
apiCommunityRouter.use(requireAuth);

function allowNsfwForUser(user: { birthDate: string | null; nsfwEnabled: boolean }) {
  const age = computeAgeFromBirthDate(user.birthDate);
  const isAdult = typeof age === "number" && age >= 18;
  return isAdult && user.nsfwEnabled;
}

apiCommunityRouter.get("/assistants", async (req, res, next) => {
  try {
    const db = getFirestore();
    const userProfile = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);

    const allowNsfw = allowNsfwForUser(userProfile);

    const list = await listPublicAssistants(db, 50);
    const filtered = allowNsfw ? list : list.filter((a) => !a.nsfwEnabled);

    return res.status(200).json({ ok: true, assistants: filtered });
  } catch (err) {
    return next(err);
  }
});

apiCommunityRouter.get("/assistants/:id", async (req, res, next) => {
  try {
    const db = getFirestore();
    const userProfile = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);

    const allowNsfw = allowNsfwForUser(userProfile);

    const a = await getAssistant(db, req.params.id);
    if (!a || !a.isPublic) {
      return res.status(404).json({ ok: false, error: "ASSISTANT_NOT_FOUND" });
    }
    if (a.nsfwEnabled && !allowNsfw) {
      return res.status(403).json({ ok: false, error: "NSFW_NOT_ALLOWED_FOR_USER" });
    }

    return res.status(200).json({ ok: true, assistant: a });
  } catch (err) {
    return next(err);
  }
});
