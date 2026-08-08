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
  type AssistantDoc,
  type AssistantPersona,
  type AssistantNudgeSettings
} from "../../modules/assistants/assistantsRepo.js";
import { generateAssistantBio } from "../../modules/assistants/generateBio.js";
import { generateAndUploadAssistantAvatar } from "../../modules/assistants/generateAvatar.js";
import { computeAgeFromBirthDate } from "../../shared/utils/safety.js";
import { sanitizeDeep } from "../../shared/utils/sanitizeDeep.js";
import {
  deleteConversationCascade,
  listOwnerConversationsByAssistant
} from "../../modules/conversations/conversationsRepo.js";
import { assistantMemoriesCol } from "../../modules/assistants/assistantMemory.js";

export const apiAssistantsRouter = Router();
apiAssistantsRouter.use(requireAuth);

function userAllowsAssistantNsfw(user: { birthDate: string | null; nsfwEnabled: boolean }, assistantNsfw: boolean) {
  const age = computeAgeFromBirthDate(user.birthDate);
  const isAdult = typeof age === "number" && age >= 18;
  if (!assistantNsfw) return true;
  return isAdult && user.nsfwEnabled;
}

const AvatarSpecSchema = z.object({
  ethnicity: z.string().min(1),
  heightCm: z.number().int().min(80).max(230),
  bodyType: z.string().min(1),
  hairStyle: z.string().min(1),
  hairColor: z.string().min(1),
  eyeColor: z.string().min(1),
  clothingStyle: z.string().min(1)
});

const VoiceNameSchema = z
  .string()
  .min(1)
  .transform((s) => s.trim())
  .default("Kore");

const OptionalStr = () =>
  z
    .string()
    .optional()
    .transform((s) => (typeof s === "string" ? s.trim() : s));

const PersonaSchema = z
  .object({
    personality: OptionalStr(),
    profession: OptionalStr(),
    identityType: OptionalStr(),
    sourceMaterial: OptionalStr(),
    backstory: OptionalStr(),
    traits: OptionalStr(),
    interests: OptionalStr(),
    values: OptionalStr(),
    speakingStyle: OptionalStr(),
    goals: OptionalStr(),
    familyNotes: OptionalStr(),
    location: OptionalStr(),
    otherNotes: OptionalStr()
  })
  .partial()
  .optional();

function normalizePersona(p?: Partial<AssistantPersona> | undefined): AssistantPersona | null | undefined {
  if (!p) return undefined;
  const cleaned: any = {};
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === "string" && v.trim()) cleaned[k] = v.trim();
  }
  return Object.keys(cleaned).length ? (cleaned as AssistantPersona) : null;
}

function normalizeNudgeSettings(input: any): AssistantNudgeSettings | null {
  if (!input) return null;
  const enabled = !!input.enabled;
  const afterIdleMinutes = Math.max(5, Math.min(60 * 24 * 14, Number(input.afterIdleMinutes ?? 180) || 180)); // 5m..14d
  const everyMinutes = Math.max(5, Math.min(60 * 24 * 14, Number(input.everyMinutes ?? 360) || 360));
  const lastNudgeAt = typeof input.lastNudgeAt === "string" ? input.lastNudgeAt : null;
  return { enabled, afterIdleMinutes, everyMinutes, lastNudgeAt };
}

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
      name: z.string().min(1),
      surname: z.string().min(1),
      age: z.number().int().min(0).max(120),
      gender: z.string().min(1),
      relationship: z.string().min(1),

      bioMode: z.enum(["manual", "auto"]).default("auto"),
      bio: z.string().optional(),

      avatarSpec: AvatarSpecSchema,

      nsfwEnabled: z.boolean().default(false),

      voiceName: VoiceNameSchema.optional(),

      persona: PersonaSchema,

      // ✅ nudge opzionale
      nudge: z
        .object({
          enabled: z.boolean().default(false),
          afterIdleMinutes: z.number().int().min(5).max(60 * 24 * 14).default(180),
          everyMinutes: z.number().int().min(5).max(60 * 24 * 14).default(360)
        })
        .optional()
    });

    const input = Body.parse(req.body);
    const db = getFirestore();

    const userProfile = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);

    if (!userAllowsAssistantNsfw(userProfile, input.nsfwEnabled)) {
      return res.status(403).json({ ok: false, error: "NSFW_NOT_ALLOWED_FOR_USER" });
    }

    const id = newAssistantId();
    const now = new Date().toISOString();

    const voiceName = (input.voiceName ?? "Kore").trim() || "Kore";
    const persona = normalizePersona(input.persona);
    const nudge = normalizeNudgeSettings({ ...input.nudge, lastNudgeAt: null });

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
          avatarSpec: input.avatarSpec,
          persona: persona ?? null
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

      voiceName,

      ...(persona !== undefined ? { persona } : {}),

      ...(nudge ? { nudge } : {}),

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
      name: z.string().min(1).optional(),
      surname: z.string().min(1).optional(),
      age: z.number().int().min(0).max(120).optional(),
      gender: z.string().min(1).optional(),
      relationship: z.string().min(1).optional(),

      bio: z.string().optional(),
      bioMode: z.enum(["manual", "auto"]).optional(),

      avatarSpec: AvatarSpecSchema.optional(),

      nsfwEnabled: z.boolean().optional(),

      voiceName: z.string().min(1).optional(),

      persona: PersonaSchema,

      nudge: z
        .object({
          enabled: z.boolean().optional(),
          afterIdleMinutes: z.number().int().min(5).max(60 * 24 * 14).optional(),
          everyMinutes: z.number().int().min(5).max(60 * 24 * 14).optional()
        })
        .optional()
    });

    const patch = Body.parse(req.body) as any;

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

    if (typeof patch.voiceName === "string") {
      patch.voiceName = patch.voiceName.trim() || "Kore";
    }

    if ("persona" in patch) {
      const persona = normalizePersona(patch.persona);
      patch.persona = persona === undefined ? undefined : persona;
      if (patch.persona === undefined) delete patch.persona;
    }

    if ("nudge" in patch) {
      const base = existing.nudge ?? { enabled: false, afterIdleMinutes: 180, everyMinutes: 360, lastNudgeAt: null };
      const merged = normalizeNudgeSettings({
        enabled: patch.nudge?.enabled ?? base.enabled,
        afterIdleMinutes: patch.nudge?.afterIdleMinutes ?? base.afterIdleMinutes,
        everyMinutes: patch.nudge?.everyMinutes ?? base.everyMinutes,
        lastNudgeAt: base.lastNudgeAt
      });
      patch.nudge = merged;
    }

    const updated = await updateAssistant(db, req.params.id, patch);
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

    const convos = await listOwnerConversationsByAssistant(db, req.user!.uid, existing.id, 200);
    for (const c of convos) {
      await deleteConversationCascade(db, c.id);
    }

    try {
      await assistantMemoriesCol(db).doc(existing.id).delete();
    } catch {}

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
        avatarSpec: existing.avatarSpec,
        persona: existing.persona ?? null
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
