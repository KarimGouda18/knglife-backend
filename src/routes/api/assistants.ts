// src/routes/api/assistants.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../shared/middleware/requireAuth.js";
import { getFirestore } from "../../config/firebase.js";
import { getOrCreateUserProfile } from "../../modules/users/userRepo.js";
import {
  newAssistantId,
  createAssistant,
  deleteAssistant,
  getAssistant,
  listOwnerAssistants,
  publishAssistant,
  unpublishAssistant,
  updateAssistant,
  type AssistantDoc
} from "../../modules/assistants/assistantsRepo.js";
import { generateAssistantBio } from "../../modules/assistants/generateBio.js";
import { generateAndUploadAssistantAvatar } from "../../modules/assistants/generateAvatar.js";
import { computeAgeFromBirthDate } from "../../shared/utils/safety.js";
import { sanitizeDeep } from "../../shared/utils/sanitizeDeep.js";

export const apiAssistantsRouter = Router();
apiAssistantsRouter.use(requireAuth);

function userAllowsAssistantNsfw(user: { birthDate: string | null; nsfwEnabled: boolean }, assistantNsfw: boolean) {
  const age = computeAgeFromBirthDate(user.birthDate);
  const isAdult = typeof age === "number" && age >= 18;
  if (!assistantNsfw) return true;
  return isAdult && user.nsfwEnabled;
}

const AvatarSpecSchema = z.object({
  ethnicity: z.string().min(1).max(50),
  heightCm: z.number().int().min(80).max(230),
  bodyType: z.string().min(1).max(50),
  hairStyle: z.string().min(1).max(60),
  hairColor: z.string().min(1).max(40),
  eyeColor: z.string().min(1).max(40),
  clothingStyle: z.string().min(1).max(80)
});

// ✅ voci consentite (lato backend, per evitare valori strani)
const VoiceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .default("Kore")
  .transform((v) => v || "Kore");

apiAssistantsRouter.get("/", async (req, res, next) => {
  try {
    const db = getFirestore();
    const list = await listOwnerAssistants(db, req.user!.uid, 50);
    return res.status(200).json(sanitizeDeep({ ok: true, assistants: list }));
  } catch (err) {
    return next(err);
  }
});

apiAssistantsRouter.post("/", async (req, res, next) => {
  try {
    const Body = z.object({
      name: z.string().min(1).max(80),
      surname: z.string().min(1).max(80),
      age: z.number().int().min(0).max(120),
      gender: z.string().min(1).max(40),
      relationship: z.string().min(1).max(120),

      bioMode: z.enum(["manual", "auto"]).default("auto"),
      bio: z.string().max(8000).optional(),

      avatarSpec: AvatarSpecSchema,

      nsfwEnabled: z.boolean().default(false),

      // ✅ NEW
      voiceName: VoiceNameSchema.optional()
    });

    const input = Body.parse(req.body);
    const db = getFirestore();

    const userProfile = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);

    if (!userAllowsAssistantNsfw(userProfile, input.nsfwEnabled)) {
      return res.status(403).json({ ok: false, error: "NSFW_NOT_ALLOWED_FOR_USER" });
    }

    const id = newAssistantId();
    const now = new Date().toISOString();

    let bio = input.bioMode === "manual" ? (input.bio ?? "").trim() : "";
    if (input.bioMode === "auto") {
      bio = await generateAssistantBio({
        assistant: {
          name: input.name,
          surname: input.surname,
          age: input.age,
          gender: input.gender,
          relationship: input.relationship,
          nsfwEnabled: input.nsfwEnabled,
          avatarSpec: input.avatarSpec
        },
        user: {
          name: userProfile.name,
          surname: userProfile.surname,
          gender: userProfile.gender,
          visualDisabilityLevel: userProfile.visualDisabilityLevel,
          birthDate: userProfile.birthDate,
          age: userProfile.age,
          nsfwEnabled: userProfile.nsfwEnabled
        }
      });
    }

    const avatar = await generateAndUploadAssistantAvatar({
      ownerUid: req.user!.uid,
      assistantId: id,
      age: input.age,
      gender: input.gender,
      avatarSpec: input.avatarSpec,
      assistantNsfwEnabled: input.nsfwEnabled,
      user: { birthDate: userProfile.birthDate, nsfwEnabled: userProfile.nsfwEnabled }
    });

    const doc: AssistantDoc = {
      id,
      ownerUid: req.user!.uid,

      name: input.name,
      surname: input.surname,
      age: input.age,
      gender: input.gender,
      relationship: input.relationship,

      bio,
      bioMode: input.bioMode,

      avatarSpec: input.avatarSpec,
      avatar,

      nsfwEnabled: input.nsfwEnabled,

      // ✅ NEW: voce salvata
      voiceName: (input.voiceName ?? "Kore").trim() || "Kore",

      isPublic: false,
      publishedAt: null,

      createdAt: now,
      updatedAt: now
    };

    await createAssistant(db, doc);

    return res.status(201).json(sanitizeDeep({ ok: true, assistant: doc }));
  } catch (err) {
    return next(err);
  }
});

apiAssistantsRouter.get("/:id", async (req, res, next) => {
  try {
    const db = getFirestore();
    const a = await getAssistant(db, req.params.id);
    if (!a || a.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "ASSISTANT_NOT_FOUND" });
    }
    return res.status(200).json(sanitizeDeep({ ok: true, assistant: a }));
  } catch (err) {
    return next(err);
  }
});

apiAssistantsRouter.put("/:id", async (req, res, next) => {
  try {
    const Body = z.object({
      name: z.string().min(1).max(80).optional(),
      surname: z.string().min(1).max(80).optional(),
      age: z.number().int().min(0).max(120).optional(),
      gender: z.string().min(1).max(40).optional(),
      relationship: z.string().min(1).max(120).optional(),

      bio: z.string().max(8000).optional(),
      bioMode: z.enum(["manual", "auto"]).optional(),

      avatarSpec: AvatarSpecSchema.optional(),

      nsfwEnabled: z.boolean().optional(),

      // ✅ NEW
      voiceName: VoiceNameSchema.optional()
    });

    const patch = Body.parse(req.body);

    const db = getFirestore();
    const existing = await getAssistant(db, req.params.id);
    if (!existing || existing.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "ASSISTANT_NOT_FOUND" });
    }

    if (patch.nsfwEnabled === true && existing.nsfwEnabled === false) {
      const userProfile = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);
      if (!userAllowsAssistantNsfw(userProfile, true)) {
        return res.status(403).json({ ok: false, error: "NSFW_NOT_ALLOWED_FOR_USER" });
      }
    }

    // Normalizza voiceName se passato come stringa vuota
    const fixedPatch: any = { ...patch };
    if (typeof fixedPatch.voiceName === "string") {
      fixedPatch.voiceName = fixedPatch.voiceName.trim() || "Kore";
    }

    const updated = await updateAssistant(db, req.params.id, fixedPatch);
    return res.status(200).json(sanitizeDeep({ ok: true, assistant: updated }));
  } catch (err) {
    return next(err);
  }
});

apiAssistantsRouter.delete("/:id", async (req, res, next) => {
  try {
    const db = getFirestore();
    const existing = await getAssistant(db, req.params.id);
    if (!existing || existing.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "ASSISTANT_NOT_FOUND" });
    }

    await deleteAssistant(db, req.params.id);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

apiAssistantsRouter.post("/:id/publish", async (req, res, next) => {
  try {
    const db = getFirestore();
    const existing = await getAssistant(db, req.params.id);
    if (!existing || existing.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "ASSISTANT_NOT_FOUND" });
    }

    const updated = await publishAssistant(db, req.params.id);
    return res.status(200).json(sanitizeDeep({ ok: true, assistant: updated }));
  } catch (err) {
    return next(err);
  }
});

apiAssistantsRouter.post("/:id/unpublish", async (req, res, next) => {
  try {
    const db = getFirestore();
    const existing = await getAssistant(db, req.params.id);
    if (!existing || existing.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "ASSISTANT_NOT_FOUND" });
    }

    const updated = await unpublishAssistant(db, req.params.id);
    return res.status(200).json(sanitizeDeep({ ok: true, assistant: updated }));
  } catch (err) {
    return next(err);
  }
});

apiAssistantsRouter.post("/:id/bio/generate", async (req, res, next) => {
  try {
    const db = getFirestore();
    const existing = await getAssistant(db, req.params.id);
    if (!existing || existing.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "ASSISTANT_NOT_FOUND" });
    }

    const userProfile = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);
    if (!userAllowsAssistantNsfw(userProfile, existing.nsfwEnabled)) {
      return res.status(403).json({ ok: false, error: "NSFW_NOT_ALLOWED_FOR_USER" });
    }

    const bio = await generateAssistantBio({
      assistant: {
        name: existing.name,
        surname: existing.surname,
        age: existing.age,
        gender: existing.gender,
        relationship: existing.relationship,
        nsfwEnabled: existing.nsfwEnabled,
        avatarSpec: existing.avatarSpec
      },
      user: {
        name: userProfile.name,
        surname: userProfile.surname,
        gender: userProfile.gender,
        visualDisabilityLevel: userProfile.visualDisabilityLevel,
        birthDate: userProfile.birthDate,
        age: userProfile.age,
        nsfwEnabled: userProfile.nsfwEnabled
      }
    });

    const updated = await updateAssistant(db, req.params.id, { bio, bioMode: "auto" });
    return res.status(200).json(sanitizeDeep({ ok: true, assistant: updated }));
  } catch (err) {
    return next(err);
  }
});

apiAssistantsRouter.post("/:id/avatar/generate", async (req, res, next) => {
  try {
    const db = getFirestore();
    const existing = await getAssistant(db, req.params.id);
    if (!existing || existing.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "ASSISTANT_NOT_FOUND" });
    }

    const userProfile = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);
    if (!userAllowsAssistantNsfw(userProfile, existing.nsfwEnabled)) {
      return res.status(403).json({ ok: false, error: "NSFW_NOT_ALLOWED_FOR_USER" });
    }

    const avatar = await generateAndUploadAssistantAvatar({
      ownerUid: req.user!.uid,
      assistantId: existing.id,
      age: existing.age,
      gender: existing.gender,
      avatarSpec: existing.avatarSpec,
      assistantNsfwEnabled: existing.nsfwEnabled,
      user: { birthDate: userProfile.birthDate, nsfwEnabled: userProfile.nsfwEnabled }
    });

    const updated = await updateAssistant(db, req.params.id, { avatar });
    return res.status(200).json(sanitizeDeep({ ok: true, assistant: updated }));
  } catch (err) {
    return next(err);
  }
});
