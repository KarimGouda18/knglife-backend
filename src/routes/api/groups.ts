// src/routes/api/groups.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../shared/middleware/requireAuth.js";
import { getFirestore } from "../../config/firebase.js";
import { getOrCreateUserProfile } from "../../modules/users/userRepo.js";
import { computeAgeFromBirthDate } from "../../shared/utils/safety.js";
import { sanitizeDeep } from "../../shared/utils/sanitizeDeep.js";
import {
  createGroup,
  deleteGroup,
  getGroup,
  listOwnerGroups,
  newGroupId,
  resolveGroupAssistants,
  updateGroup,
  type GroupDoc
} from "../../modules/groups/groupsRepo.js";

export const apiGroupsRouter = Router();
apiGroupsRouter.use(requireAuth);

function userAllowsAnyAssistantNsfw(user: { birthDate: string | null; nsfwEnabled: boolean }, anyAssistantNsfw: boolean) {
  const age = computeAgeFromBirthDate(user.birthDate);
  const isAdult = typeof age === "number" && age >= 18;
  if (!anyAssistantNsfw) return true;
  return isAdult && user.nsfwEnabled;
}

const BodySchema = z.object({
  name: z.string().min(1).max(80),
  context: z.string().max(4000).optional(),
  assistantIds: z.array(z.string().min(1)).min(1).max(20)
});

const PatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  context: z.string().max(4000).nullable().optional(),
  assistantIds: z.array(z.string().min(1)).min(1).max(20).optional()
});

apiGroupsRouter.get("/", async (req, res, next) => {
  try {
    const db = getFirestore();
    const list = await listOwnerGroups(db, req.user!.uid, 50);
    return res.status(200).json(sanitizeDeep({ ok: true, groups: list }));
  } catch (err) {
    return next(err);
  }
});

apiGroupsRouter.post("/", async (req, res, next) => {
  try {
    const input = BodySchema.parse(req.body);
    const db = getFirestore();

    // valida assistenti e ownership
    const assistants = await resolveGroupAssistants({
      db,
      ownerUid: req.user!.uid,
      assistantIds: input.assistantIds
    });

    // gating NSFW: se nel gruppo c'è almeno un assistente nsfw
    const userProfile = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);
    const anyNsfw = assistants.some((a) => a.nsfwEnabled);

    if (!userAllowsAnyAssistantNsfw(userProfile, anyNsfw)) {
      return res.status(403).json({ ok: false, error: "NSFW_NOT_ALLOWED_FOR_USER" });
    }

    const id = newGroupId();
    const now = new Date().toISOString();

    const doc: GroupDoc = {
      id,
      ownerUid: req.user!.uid,
      name: input.name.trim(),
      context: (input.context ?? "").trim() ? (input.context ?? "").trim() : null,
      assistantIds: Array.from(new Set(input.assistantIds)),

      createdAt: now,
      updatedAt: now
    };

    await createGroup(db, doc);
    return res.status(201).json(sanitizeDeep({ ok: true, group: doc }));
  } catch (err) {
    return next(err);
  }
});

apiGroupsRouter.get("/:id", async (req, res, next) => {
  try {
    const db = getFirestore();
    const g = await getGroup(db, req.params.id);
    if (!g || g.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "GROUP_NOT_FOUND" });
    }
    return res.status(200).json(sanitizeDeep({ ok: true, group: g }));
  } catch (err) {
    return next(err);
  }
});

apiGroupsRouter.put("/:id", async (req, res, next) => {
  try {
    const patch = PatchSchema.parse(req.body);
    const db = getFirestore();

    const existing = await getGroup(db, req.params.id);
    if (!existing || existing.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "GROUP_NOT_FOUND" });
    }

    let nextAssistantIds = existing.assistantIds;
    if (patch.assistantIds) {
      nextAssistantIds = Array.from(new Set(patch.assistantIds));
      const assistants = await resolveGroupAssistants({
        db,
        ownerUid: req.user!.uid,
        assistantIds: nextAssistantIds
      });

      const userProfile = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);
      const anyNsfw = assistants.some((a) => a.nsfwEnabled);

      if (!userAllowsAnyAssistantNsfw(userProfile, anyNsfw)) {
        return res.status(403).json({ ok: false, error: "NSFW_NOT_ALLOWED_FOR_USER" });
      }
    }

    const toSave: any = { ...patch };
    if (typeof patch.name === "string") toSave.name = patch.name.trim();

    if (patch.context !== undefined) {
      const v = patch.context;
      toSave.context = v === null ? null : (v.trim() ? v.trim() : null);
    }

    if (patch.assistantIds) toSave.assistantIds = nextAssistantIds;

    const updated = await updateGroup(db, req.params.id, toSave);
    return res.status(200).json(sanitizeDeep({ ok: true, group: updated }));
  } catch (err) {
    return next(err);
  }
});

apiGroupsRouter.delete("/:id", async (req, res, next) => {
  try {
    const db = getFirestore();
    const existing = await getGroup(db, req.params.id);
    if (!existing || existing.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "GROUP_NOT_FOUND" });
    }

    await deleteGroup(db, req.params.id);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
