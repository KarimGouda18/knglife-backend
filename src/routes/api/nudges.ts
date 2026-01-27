// src/routes/api/nudges.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../shared/middleware/requireAuth.js";
import { getFirestore } from "../../config/firebase.js";
import { getAssistant, updateAssistant } from "../../modules/assistants/assistantsRepo.js";
import { getOrCreateUserProfile } from "../../modules/users/userRepo.js";
import { getLatestConversationByAssistant, addMessage, updateConversation } from "../../modules/conversations/conversationsRepo.js";
import { buildAssistantRecallContext } from "../../modules/conversations/recall.js";
import { upsertAssistantMemory } from "../../modules/assistants/assistantMemory.js";
import { updateConversationSummary } from "../../modules/conversations/updateSummary.js";
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { sanitizeForJson } from "../../shared/utils/text.js";
import { sanitizeDeep } from "../../shared/utils/sanitizeDeep.js";

/**
 * Messaggi estemporanei:
 * - Config per assistente: PUT /api/nudges/assistants/:id
 * - Tick (da Cloud Scheduler): POST /api/nudges/tick con header x-cron-token
 *
 * Nota: su Cloud Run i "timer in-process" non sono affidabili; il tick va schedulato esternamente.
 */
export const apiNudgesRouter = Router();

apiNudgesRouter.put("/assistants/:id", requireAuth, async (req, res, next) => {
  try {
    const Body = z.object({
      enabled: z.boolean(),
      afterIdleMinutes: z.number().int().min(5).max(60 * 24 * 14),
      everyMinutes: z.number().int().min(5).max(60 * 24 * 14)
    });
    const input = Body.parse(req.body);

    const db = getFirestore();
    const a = await getAssistant(db, req.params.id);
    if (!a || a.ownerUid !== req.user!.uid) return res.status(404).json({ ok: false, error: "ASSISTANT_NOT_FOUND" });

    const nudge = {
      enabled: input.enabled,
      afterIdleMinutes: input.afterIdleMinutes,
      everyMinutes: input.everyMinutes,
      lastNudgeAt: a.nudge?.lastNudgeAt ?? null
    };

    const updated = await updateAssistant(db, a.id, { nudge });
    return res.status(200).json(sanitizeDeep({ ok: true, assistant: updated }));
  } catch (err) {
    return next(err);
  }
});

apiNudgesRouter.post("/tick", async (req, res, next) => {
  try {
    const cronToken = process.env.CRON_TOKEN || "";
    if (!cronToken) {
      return res.status(501).json({ ok: false, error: "CRON_TOKEN_NOT_CONFIGURED" });
    }
    const got = String(req.headers["x-cron-token"] ?? "");
    if (got !== cronToken) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const db = getFirestore();

    // Trova assistants con nudge.enabled == true (serve index se non esiste)
    const snap = await db.collection("assistants").where("nudge.enabled", "==", true).limit(200).get();
    const assistants = snap.docs.map((d) => d.data() as any);

    let processed = 0;
    let sent = 0;

    for (const a of assistants) {
      processed++;

      const n = a.nudge;
      if (!n?.enabled) continue;

      const ownerUid = a.ownerUid as string;
      const assistantId = a.id as string;

      // ultima conversazione con quell’assistente
      const convo = await getLatestConversationByAssistant(db, ownerUid, assistantId);
      if (!convo) continue;

      const now = Date.now();
      const convoUpdatedAt = Date.parse(convo.updatedAt || convo.createdAt);
      const idleMs = now - convoUpdatedAt;

      const afterIdleMs = Number(n.afterIdleMinutes) * 60_000;
      if (!(idleMs >= afterIdleMs)) continue;

      const lastNudgeAt = n.lastNudgeAt ? Date.parse(n.lastNudgeAt) : 0;
      const everyMs = Number(n.everyMinutes) * 60_000;
      if (lastNudgeAt && now - lastNudgeAt < everyMs) continue;

      // genera un messaggio breve, non invadente, usando memoria + recall
      const userProfile = await getOrCreateUserProfile(db, ownerUid, null);
      const { assistantMemory, recallText } = await buildAssistantRecallContext({
        db,
        ownerUid,
        assistantId,
        excludeConversationId: convo.id
      });

      const ai = getGenAI();
      const safetySettings = getGeminiSafetySettings({
        userBirthDate: userProfile.birthDate,
        userNsfwEnabled: userProfile.nsfwEnabled,
        assistantNsfwEnabled: !!a.nsfwEnabled
      });

      const prompt = [
        `Sei un assistente in KNGLife. Vuoi inviare un messaggio estemporaneo (nudge) all'utente.`,
        `Vincoli:`,
        `- Italiano`,
        `- 1-2 frasi (max 220 caratteri)`,
        `- tono umano, caldo, NON pressante`,
        `- niente emoji`,
        `- proponi un piccolo spunto coerente con memoria/recall`,
        ``,
        `Memoria assistente:`,
        assistantMemory?.trim() || "(vuota)",
        ``,
        `Richiami conversazioni precedenti:`,
        recallText?.trim() || "(nessuno)",
        ``,
        `Riassunto conversazione corrente:`,
        (convo.summary ?? "").trim() || "(vuoto)",
        ``,
        `Output: solo il messaggio`
      ].join("\n");

      const resp = await ai.models.generateContent({
        model: env.GEMINI_TEXT_MODEL,
        contents: prompt,
        config: { safetySettings }
      });

      const raw =
        resp.candidates?.[0]?.content?.parts
          ?.map((pp: any) => pp.text)
          .filter(Boolean)
          .join("") ?? "";

      const text = sanitizeForJson(raw).trim();
      if (!text) continue;

      await addMessage(db, convo.id, {
        role: "assistant",
        content: text,
        parts: [{ type: "text", text }]
      });

      // aggiorna summary + memoria
      const nextSummary = await updateConversationSummary({
        user: { birthDate: userProfile.birthDate, nsfwEnabled: userProfile.nsfwEnabled },
        assistant: { nsfwEnabled: !!a.nsfwEnabled },
        previousSummary: convo.summary ?? null,
        lastUserText: "(nudge automatico)",
        lastAssistantText: text
      });
      await updateConversation(db, convo.id, { summary: nextSummary });

      await upsertAssistantMemory({
        db,
        ownerUid,
        assistant: {
          id: assistantId,
          name: a.name,
          surname: a.surname,
          nsfwEnabled: !!a.nsfwEnabled,
          relationship: a.relationship
        },
        user: { birthDate: userProfile.birthDate, nsfwEnabled: userProfile.nsfwEnabled },
        currentMemory: assistantMemory,
        newConversationDelta: `Assistente (nudge): ${text}`
      });

      // segna lastNudgeAt
      await updateAssistant(db, assistantId, { nudge: { ...n, lastNudgeAt: new Date().toISOString() } });

      sent++;
    }

    return res.status(200).json(sanitizeDeep({ ok: true, processed, sent }));
  } catch (err) {
    return next(err);
  }
});
