// src/routes/api/community.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../shared/middleware/requireAuth.js";
import { getFirestore } from "../../config/firebase.js";
import { getOrCreateUserProfile } from "../../modules/users/userRepo.js";
import {
  getAssistant,
  listPublicAssistants,
  createAssistant,
  newAssistantId,
  type AssistantDoc
} from "../../modules/assistants/assistantsRepo.js";
import { computeAgeFromBirthDate } from "../../shared/utils/safety.js";
import { sanitizeDeep } from "../../shared/utils/sanitizeDeep.js";

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

    return res.status(200).json(sanitizeDeep({ ok: true, assistants: filtered }));
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

    return res.status(200).json(sanitizeDeep({ ok: true, assistant: a }));
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/community/assistants/:id/clone
 * Clona un assistente pubblico nel profilo dell'utente (nuovo id, privato di default).
 *
 * Body opzionale:
 *   - relationship: stringa (max 120 car.) per sovrascrivere la relazione con il clonatore.
 *     Se omessa, viene mantenuta quella originale dell'assistente sorgente.
 */
apiCommunityRouter.post("/assistants/:id/clone", async (req, res, next) => {
  try {
    const Body = z.object({
      relationship: z.string().min(1).max(120).optional()
    });

    const { relationship: customRelationship } = Body.parse(req.body);

    const db = getFirestore();

    const userProfile = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);
    const allowNsfw = allowNsfwForUser(userProfile);

    const source = await getAssistant(db, req.params.id);
    if (!source || !source.isPublic) {
      return res.status(404).json({ ok: false, error: "ASSISTANT_NOT_FOUND" });
    }

    // Gating NSFW: se l'assistente è NSFW, l'utente deve essere maggiorenne + nsfwEnabled profilo ON
    if (source.nsfwEnabled && !allowNsfw) {
      return res.status(403).json({ ok: false, error: "NSFW_NOT_ALLOWED_FOR_USER" });
    }

    const now = new Date().toISOString();
    const id = newAssistantId();

    // La relazione viene sovrascritta se l'utente ne specifica una; altrimenti si mantiene quella originale.
    const relationship =
      typeof customRelationship === "string" && customRelationship.trim()
        ? customRelationship.trim()
        : source.relationship;

    const cloned: AssistantDoc = {
      id,
      ownerUid: req.user!.uid,

      name: source.name,
      surname: source.surname,
      age: source.age,
      gender: source.gender,
      relationship,

      bio: source.bio,
      bioMode: source.bioMode,

      avatarSpec: source.avatarSpec,
      // Copiamo l'avatar così com'è (includendo downloadUrl).
      // L'utente può rigenerarlo via POST /:id/avatar/generate dopo il clone.
      avatar: source.avatar ?? null,

      nsfwEnabled: source.nsfwEnabled,

      voiceName: source.voiceName ?? "Kore",

      ...(source.persona != null ? { persona: source.persona } : {}),

      // Il clone nasce privato; l'utente può pubblicarlo in seguito
      isPublic: false,
      publishedAt: null,

      clonedFromAssistantId: source.id,
      clonedFromOwnerUid: source.ownerUid,
      clonedAt: now,

      createdAt: now,
      updatedAt: now
    };

    await createAssistant(db, cloned);

    return res.status(201).json(sanitizeDeep({ ok: true, assistant: cloned }));
  } catch (err) {
    return next(err);
  }
});