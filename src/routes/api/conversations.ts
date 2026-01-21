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
import { sanitizeDeep } from "../../shared/utils/sanitizeDeep.js";
import { generateConversationImage, generateConversationVideo } from "../../modules/conversations/mediaGen.js";

export const apiConversationsRouter = Router();
apiConversationsRouter.use(requireAuth);

const PartsSchema = z.array(
  z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.literal("inline_data"),
      mimeType: z.string().min(1),
      dataBase64: z.string().min(1)
    }),
    // ✅ nuovo: file_url (displayName è opzionale e NON verrà passato a Gemini)
    z.object({
      type: z.literal("file_url"),
      mimeType: z.string().min(1),
      url: z.string().url(),
      displayName: z.string().min(1).max(200).optional()
    })
  ])
);

apiConversationsRouter.get("/", async (req, res, next) => {
  try {
    const db = getFirestore();
    const list = await listOwnerConversations(db, req.user!.uid, 50);
    return res.status(200).json(sanitizeDeep({ ok: true, conversations: list }));
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

    return res.status(201).json(sanitizeDeep({ ok: true, conversation: convo }));
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
    return res.status(200).json(sanitizeDeep({ ok: true, conversation: convo }));
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
    return res.status(200).json(sanitizeDeep({ ok: true, messages: msgs }));
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

    const userMsg = await addMessage(db, convo.id, {
      role: "user",
      content: parts
        .map((p) => {
          if (p.type === "text") return p.text;
          if (p.type === "file_url") return `[file:${p.mimeType}]`;
          return "";
        })
        .join(" ")
        .trim(),
      parts
    });

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

    return res
      .status(200)
      .json(sanitizeDeep({ ok: true, userMessage: userMsg, assistantMessage: assistantMsg }));
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/conversations/:id/generate/image
 * Body: { prompt: string, useAssistantAvatar?: boolean }
 */
apiConversationsRouter.post("/:id/generate/image", async (req, res, next) => {
  try {
    const Body = z.object({
      prompt: z.string().min(1).max(4000),
      useAssistantAvatar: z.boolean().optional()
    });
    const { prompt, useAssistantAvatar } = Body.parse(req.body);

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

    const media = await generateConversationImage({
      ownerUid: req.user!.uid,
      conversationId: convo.id,
      prompt,
      useAssistantAvatar: !!useAssistantAvatar,
      user: { birthDate: userProfile.birthDate, nsfwEnabled: userProfile.nsfwEnabled },
      assistant: { nsfwEnabled: assistant.nsfwEnabled, avatar: assistant.avatar }
    });

    const msg = await addMessage(db, convo.id, {
      role: "assistant",
      content: `Ho generato un'immagine: ${media.downloadUrl}`,
      parts: [{ type: "text", text: `Ho generato un'immagine: ${media.downloadUrl}` }]
    });

    return res.status(200).json(sanitizeDeep({ ok: true, media, message: msg }));
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/conversations/:id/generate/video
 * Body: { prompt: string, useAssistantAvatar?: boolean }
 */
apiConversationsRouter.post("/:id/generate/video", async (req, res, next) => {
  try {
    const Body = z.object({
      prompt: z.string().min(1).max(4000),
      useAssistantAvatar: z.boolean().optional()
    });
    const { prompt, useAssistantAvatar } = Body.parse(req.body);

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

    const media = await generateConversationVideo({
      ownerUid: req.user!.uid,
      conversationId: convo.id,
      prompt,
      useAssistantAvatar: !!useAssistantAvatar,
      user: { birthDate: userProfile.birthDate, nsfwEnabled: userProfile.nsfwEnabled },
      assistant: { nsfwEnabled: assistant.nsfwEnabled, avatar: assistant.avatar }
    });

    const msg = await addMessage(db, convo.id, {
      role: "assistant",
      content: `Ho generato un video: ${media.downloadUrl}`,
      parts: [{ type: "text", text: `Ho generato un video: ${media.downloadUrl}` }]
    });

    return res.status(200).json(sanitizeDeep({ ok: true, media, message: msg }));
  } catch (err) {
    return next(err);
  }
});
