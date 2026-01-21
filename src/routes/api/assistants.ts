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
  type AssistantPersona
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
  ethnicity: z.string().min(1).max(50),
  heightCm: z.number().int().min(80).max(230),
  bodyType: z.string().min(1).max(50),
  hairStyle: z.string().min(1).max(60),
  hairColor: z.string().min(1).max(40),
  eyeColor: z.string().min(1).max(40),
  clothingStyle: z.string().min(1).max(80)
});

const VoiceNameSchema = z
  .string()
  .min(1)
  .max(40)
  .transform((s) => s.trim())
  .default("Kore");

const OptionalStr = (max = 2000) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((s) => (typeof s === "string" ? s.trim() : s))
    .refine((s) => s === undefined || s.length <= max, "STRING_TOO_LONG");

const PersonaSchema = z
  .object({
    personality: OptionalStr(2000),
    profession: OptionalStr(2000),
    identityType: OptionalStr(200),
    sourceMaterial: OptionalStr(400),
    backstory: OptionalStr(4000),
    traits: OptionalStr(2000),
    interests: OptionalStr(2000),
    values: OptionalStr(2000),
    speakingStyle: OptionalStr(2000),
    goals: OptionalStr(2000),
    familyNotes: OptionalStr(2000),
    location: OptionalStr(2000),
    otherNotes: OptionalStr(4000)
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

      // ✅ VOCE LIVE ASSISTANT
      voiceName: VoiceNameSchema.optional(),

      // ✅ nuovi campi opzionali (persona)
      persona: PersonaSchema
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

    // ✅ se manual -> resta quello dell'utente; se auto -> generazione con persona
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

      // ✅ optional persona
      ...(persona !== undefined ? { persona } : {}),

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

      voiceName: z.string().min(1).max(40).optional(),

      persona: PersonaSchema
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

    // normalizza persona
    if ("persona" in patch) {
      const persona = normalizePersona(patch.persona);
      patch.persona = persona === undefined ? undefined : persona;
      // se persona è undefined, non vogliamo scrivere undefined in Firestore
      if (patch.persona === undefined) delete patch.persona;
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

    // ✅ Cascade delete: elimina tutte le conversazioni associate (e messaggi)
    const convos = await listOwnerConversationsByAssistant(db, req.user!.uid, existing.id, 200);
    for (const c of convos) {
      await deleteConversationCascade(db, c.id);
    }

    // ✅ elimina memoria assistant (best-effort)
    try {
      await assistantMemoriesCol(db).doc(existing.id).delete();
    } catch {
      // ignore
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
