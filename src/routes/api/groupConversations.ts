// src/routes/api/groupConversations.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../shared/middleware/requireAuth.js";
import { getFirestore } from "../../config/firebase.js";
import { getOrCreateUserProfile } from "../../modules/users/userRepo.js";
import { sanitizeDeep } from "../../shared/utils/sanitizeDeep.js";
import { getGroup, resolveGroupAssistants } from "../../modules/groups/groupsRepo.js";
import { runGroupConversation } from "../../modules/groups/runGroupConversation.js";
import {
  addGroupMessage,
  createGroupConversation,
  deleteGroupConversation,
  getGroupConversation,
  listGroupMessages,
  listOwnerGroupConversations,
  newId
} from "../../modules/groupConversations/groupConversationsRepo.js";

export const apiGroupConversationsRouter = Router();
apiGroupConversationsRouter.use(requireAuth);

const PartsSchema = z.array(
  z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.literal("inline_data"),
      mimeType: z.string().min(1),
      dataBase64: z.string().min(1)
    })
  ])
);

apiGroupConversationsRouter.get("/", async (req, res, next) => {
  try {
    const db = getFirestore();
    const list = await listOwnerGroupConversations(db, req.user!.uid, 50);
    return res.status(200).json(sanitizeDeep({ ok: true, conversations: list }));
  } catch (err) {
    return next(err);
  }
});

apiGroupConversationsRouter.post("/", async (req, res, next) => {
  try {
    const Body = z.object({
      groupId: z.string().min(1),
      title: z.string().max(120).optional()
    });

    const { groupId, title } = Body.parse(req.body);
    const db = getFirestore();

    const group = await getGroup(db, groupId);
    if (!group || group.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "GROUP_NOT_FOUND" });
    }

    const convo = await createGroupConversation(db, {
      id: newId(),
      ownerUid: req.user!.uid,
      groupId,
      title: title ?? null
    });

    return res.status(201).json(sanitizeDeep({ ok: true, conversation: convo }));
  } catch (err) {
    return next(err);
  }
});

apiGroupConversationsRouter.get("/:id", async (req, res, next) => {
  try {
    const db = getFirestore();
    const convo = await getGroupConversation(db, req.params.id);
    if (!convo || convo.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "CONVERSATION_NOT_FOUND" });
    }
    return res.status(200).json(sanitizeDeep({ ok: true, conversation: convo }));
  } catch (err) {
    return next(err);
  }
});

apiGroupConversationsRouter.delete("/:id", async (req, res, next) => {
  try {
    const db = getFirestore();
    const convo = await getGroupConversation(db, req.params.id);
    if (!convo || convo.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "CONVERSATION_NOT_FOUND" });
    }

    await deleteGroupConversation(db, req.params.id);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

apiGroupConversationsRouter.get("/:id/messages", async (req, res, next) => {
  try {
    const db = getFirestore();
    const convo = await getGroupConversation(db, req.params.id);
    if (!convo || convo.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "CONVERSATION_NOT_FOUND" });
    }

    const msgs = await listGroupMessages(db, req.params.id, 80);
    return res.status(200).json(sanitizeDeep({ ok: true, messages: msgs }));
  } catch (err) {
    return next(err);
  }
});

apiGroupConversationsRouter.post("/:id/message", async (req, res, next) => {
  try {
    const Body = z.object({ parts: PartsSchema });
    const { parts } = Body.parse(req.body);

    const db = getFirestore();

    const convo = await getGroupConversation(db, req.params.id);
    if (!convo || convo.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "CONVERSATION_NOT_FOUND" });
    }

    const group = await getGroup(db, convo.groupId);
    if (!group || group.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "GROUP_NOT_FOUND" });
    }

    const userProfile = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);

    // resolve assistants del gruppo
    const assistants = await resolveGroupAssistants({
      db,
      ownerUid: req.user!.uid,
      assistantIds: group.assistantIds
    });

    const userMsg = await addGroupMessage(db, convo.id, {
      role: "user",
      content: parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim(),
      parts
    });

    // history: user+assistant (tutto), ma per Gemini user= user, assistant = model
    const msgs = await listGroupMessages(db, convo.id, 80);
    const history = msgs.map((m) => ({
      role: m.role,
      parts: m.parts
    })) as { role: "user" | "assistant"; parts: any[] }[];

    // Nota: per la run passiamo l'history SENZA il "system", e l'ultimo userParts separato
    const replies = await runGroupConversation({
      history,
      lastUserParts: parts,
      userProfile,
      group,
      assistants
    });

    const assistantMessages = [];
    for (const r of replies) {
      const saved = await addGroupMessage(db, convo.id, {
        role: "assistant",
        assistantId: r.assistant.id,
        assistantName: `${r.assistant.name} ${r.assistant.surname}`,
        content: r.reply,
        parts: [{ type: "text", text: r.reply }]
      });
      assistantMessages.push(saved);
    }

    return res.status(200).json(
      sanitizeDeep({
        ok: true,
        userMessage: userMsg,
        assistantMessages
      })
    );
  } catch (err) {
    return next(err);
  }
});
