// src/routes/api/conversations.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../shared/middleware/requireAuth.js";
import { getFirestore } from "../../config/firebase.js";
import { getAssistant } from "../../modules/assistants/assistantsRepo.js";
import { getOrCreateUserProfile } from "../../modules/users/userRepo.js";
import {
  addMessage,
  createConversation,
  deleteConversation,
  getConversation,
  listMessages,
  listOwnerConversations,
  newId
} from "../../modules/conversations/conversationsRepo.js";
import { runConversation } from "../../modules/conversations/runConversation.js";

export const apiConversationsRouter = Router();
apiConversationsRouter.use(requireAuth);

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

apiConversationsRouter.get("/", async (req, res, next) => {
  try {
    const db = getFirestore();
    const list = await listOwnerConversations(db, req.user!.uid, 50);
    return res.status(200).json({ ok: true, conversations: list });
  } catch (err) {
    return next(err);
  }
});

apiConversationsRouter.post("/", async (req, res, next) => {
  try {
    const Body = z.object({
      assistantId: z.string().min(1),
      title: z.string().max(120).optional()
    });

    const { assistantId, title } = Body.parse(req.body);

    const db = getFirestore();

    const assistant = await getAssistant(db, assistantId);
    if (!assistant || assistant.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "ASSISTANT_NOT_FOUND" });
    }

    const convo = await createConversation(db, {
      id: newId(),
      ownerUid: req.user!.uid,
      assistantId,
      title: title ?? null,
      nsfwEnabled: assistant.nsfwEnabled
    });

    return res.status(201).json({ ok: true, conversation: convo });
  } catch (err) {
    return next(err);
  }
});

apiConversationsRouter.get("/:id", async (req, res, next) => {
  try {
    const db = getFirestore();
    const convo = await getConversation(db, req.params.id);
    if (!convo || convo.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "CONVERSATION_NOT_FOUND" });
    }
    return res.status(200).json({ ok: true, conversation: convo });
  } catch (err) {
    return next(err);
  }
});

apiConversationsRouter.delete("/:id", async (req, res, next) => {
  try {
    const db = getFirestore();
    const convo = await getConversation(db, req.params.id);
    if (!convo || convo.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "CONVERSATION_NOT_FOUND" });
    }

    await deleteConversation(db, req.params.id);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

apiConversationsRouter.get("/:id/messages", async (req, res, next) => {
  try {
    const db = getFirestore();
    const convo = await getConversation(db, req.params.id);
    if (!convo || convo.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "CONVERSATION_NOT_FOUND" });
    }

    const msgs = await listMessages(db, req.params.id, 60);
    return res.status(200).json({ ok: true, messages: msgs });
  } catch (err) {
    return next(err);
  }
});

apiConversationsRouter.post("/:id/message", async (req, res, next) => {
  try {
    const Body = z.object({ parts: PartsSchema });
    const { parts } = Body.parse(req.body);

    const db = getFirestore();

    const convo = await getConversation(db, req.params.id);
    if (!convo || convo.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "CONVERSATION_NOT_FOUND" });
    }

    const assistant = await getAssistant(db, convo.assistantId);
    if (!assistant || assistant.ownerUid !== req.user!.uid) {
      return res.status(404).json({ ok: false, error: "ASSISTANT_NOT_FOUND" });
    }

    const userProfile = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);

    // salva il messaggio utente
    const userMsg = await addMessage(db, convo.id, {
      role: "user",
      content: parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim(),
      parts
    });

    // history (incluso userMsg appena creato)
    const msgs = await listMessages(db, convo.id, 40);
    const history = msgs
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", parts: m.parts }));

    const reply = await runConversation({
      history,
      userProfile,
      assistant
    });

    const assistantMsg = await addMessage(db, convo.id, {
      role: "assistant",
      content: reply,
      parts: [{ type: "text", text: reply }]
    });

    return res.status(200).json({ ok: true, userMessage: userMsg, assistantMessage: assistantMsg });
  } catch (err) {
    return next(err);
  }
});
