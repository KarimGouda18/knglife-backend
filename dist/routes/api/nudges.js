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
 * Nudge (proactive message) endpoints:
 *
 * - PUT  /api/nudges/assistants/:id  — configure nudge settings for an assistant
 * - POST /api/nudges/heartbeat       — signal that the authenticated user is currently active
 * - POST /api/nudges/tick            — cron-triggered: evaluate and send pending nudges
 *
 * Architecture note: Cloud Run instances cannot reliably run in-process timers.
 * The tick endpoint must be called by an external scheduler (Cloud Scheduler).
 * Set up a job that POSTs to /api/nudges/tick every 5 minutes with the
 * `x-cron-token` header set to the value of the CRON_TOKEN secret.
 */
export const apiNudgesRouter = Router();
// ---------------------------------------------------------------------------
// PUT /api/nudges/assistants/:id — configure nudge settings
// ---------------------------------------------------------------------------
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
        if (!a || a.ownerUid !== req.user.uid) {
            return res.status(404).json({ ok: false, error: "ASSISTANT_NOT_FOUND" });
        }
        const nudge = {
            enabled: input.enabled,
            afterIdleMinutes: input.afterIdleMinutes,
            everyMinutes: input.everyMinutes,
            lastNudgeAt: a.nudge?.lastNudgeAt ?? null
        };
        const updated = await updateAssistant(db, a.id, { nudge });
        return res.status(200).json(sanitizeDeep({ ok: true, assistant: updated }));
    }
    catch (err) {
        return next(err);
    }
});
// ---------------------------------------------------------------------------
// POST /api/nudges/heartbeat — signal user activity
// ---------------------------------------------------------------------------
/**
 * The frontend should call this endpoint every 60–90 seconds while the app is
 * visible (document.visibilityState === "visible") and immediately on a
 * visibilitychange event from hidden → visible.
 *
 * The recorded timestamp is used by the tick logic to determine whether the user
 * is truly idle, as opposed to merely not having sent a message recently.
 */
apiNudgesRouter.post("/heartbeat", requireAuth, async (req, res, next) => {
    try {
        const db = getFirestore();
        await db.collection("users").doc(req.user.uid).set({ lastActiveAt: new Date().toISOString() }, { merge: true });
        return res.status(200).json({ ok: true });
    }
    catch (err) {
        return next(err);
    }
});
// ---------------------------------------------------------------------------
// POST /api/nudges/tick — evaluate and send nudges (called by Cloud Scheduler)
// ---------------------------------------------------------------------------
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
        // Fetch all assistants and filter in-memory for nudge.enabled === true.
        // This avoids the need for a composite Firestore index.
        const snap = await db.collection("assistants").limit(500).get();
        const allAssistants = snap.docs.map((d) => d.data());
        const assistantsWithNudge = allAssistants.filter((a) => a.nudge?.enabled === true);
        let processed = 0;
        let sent = 0;
        const errors = [];
        for (const a of assistantsWithNudge) {
            try {
                processed++;
                const n = a.nudge;
                if (!n?.enabled)
                    continue;
                const ownerUid = a.ownerUid;
                const assistantId = a.id;
                const convo = await getLatestConversationByAssistant(db, ownerUid, assistantId);
                if (!convo)
                    continue;
                const now = Date.now();
                // Use whichever activity signal is more recent: the heartbeat timestamp
                // (updated while the user is browsing the app) or the last conversation
                // update (updated when a message is sent). This prevents false nudges
                // when the user is active but hasn't typed anything.
                const userProfile = await getOrCreateUserProfile(db, ownerUid, null);
                const heartbeatTs = userProfile.lastActiveAt ? Date.parse(userProfile.lastActiveAt) : null;
                const convoUpdatedTs = Date.parse(convo.updatedAt || convo.createdAt);
                const latestActivity = heartbeatTs ? Math.max(heartbeatTs, convoUpdatedTs) : convoUpdatedTs;
                const idleMs = now - latestActivity;
                const afterIdleMs = Number(n.afterIdleMinutes) * 60_000;
                if (idleMs < afterIdleMs)
                    continue;
                const lastNudgeAt = n.lastNudgeAt ? Date.parse(n.lastNudgeAt) : 0;
                const everyMs = Number(n.everyMinutes) * 60_000;
                if (lastNudgeAt && now - lastNudgeAt < everyMs)
                    continue;
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
                // System instruction: all context that shapes who the assistant is and what
                // they know. Kept separate from the trigger so Gemini treats it as a true
                // system prompt and not as a user message.
                const nudgeSystemInstruction = [
                    `You are ${a.name}${a.surname ? " " + a.surname : ""}, an AI companion in KNGLife.`,
                    `Your only task right now: write a brief, warm proactive message (a "nudge") to re-engage the user.`,
                    ``,
                    `Rules:`,
                    `- Reply in Italian`,
                    `- 1–2 sentences, maximum 220 characters total`,
                    `- Tone: warm and human, never pushy or robotic`,
                    `- No emoji`,
                    `- Tie the message naturally to something from the assistant's memory or the recent conversation`,
                    `- Output ONLY the nudge text — no preamble, no quotes, no labels`,
                    ``,
                    `=== Assistant memory ===`,
                    assistantMemory?.trim() || "(empty)",
                    ``,
                    `=== Recall from previous conversations ===`,
                    recallText?.trim() || "(none)",
                    ``,
                    `=== Current conversation summary ===`,
                    (convo.summary ?? "").trim() || "(empty)"
                ].join("\n");
                // The user turn is a minimal trigger. It is never saved to Firestore —
                // it only exists to satisfy the Gemini API's requirement that `contents`
                // contains at least one user message.
                const resp = await ai.models.generateContent({
                    model: env.GEMINI_TEXT_MODEL,
                    contents: [{ role: "user", parts: [{ text: "Send the check-in message now." }] }],
                    config: { systemInstruction: nudgeSystemInstruction, safetySettings }
                });
                const raw = resp.candidates?.[0]?.content?.parts
                    ?.map((pp) => pp.text)
                    .filter(Boolean)
                    .join("") ?? "";
                const text = sanitizeForJson(raw).trim();
                if (!text)
                    continue;
                await addMessage(db, convo.id, {
                    role: "assistant",
                    content: text,
                    parts: [{ type: "text", text }]
                });
                // Update summary and memory best-effort (failures do not block the nudge)
                try {
                    const nextSummary = await updateConversationSummary({
                        user: { birthDate: userProfile.birthDate, nsfwEnabled: userProfile.nsfwEnabled },
                        assistant: { nsfwEnabled: !!a.nsfwEnabled },
                        previousSummary: convo.summary ?? null,
                        lastUserText: "(automatic nudge)",
                        lastAssistantText: text
                    });
                    await updateConversation(db, convo.id, { summary: nextSummary });
                }
                catch (e) {
                    console.error(`Failed to update summary for conversation ${convo.id}:`, e);
                }
                try {
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
                        newConversationDelta: `Assistant (nudge): ${text}`
                    });
                }
                catch (e) {
                    console.error(`Failed to update memory for assistant ${assistantId}:`, e);
                }
                await updateAssistant(db, assistantId, { nudge: { ...n, lastNudgeAt: new Date().toISOString() } });
                sent++;
            }
            catch (e) {
                const errMsg = `Assistant ${a.id}: ${e?.message ?? String(e)}`;
                errors.push(errMsg);
                console.error(`Nudge tick error for assistant ${a.id}:`, e);
            }
        }
        return res.status(200).json(sanitizeDeep({ ok: true, processed, sent, errors: errors.length > 0 ? errors : undefined }));
    }
    catch (err) {
        return next(err);
    }
});
