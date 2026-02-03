import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { sanitizeForJson } from "../../shared/utils/text.js";
const colName = "assistantMemories";
const nowIso = () => new Date().toISOString();
export function assistantMemoriesCol(db) {
    return db.collection(colName);
}
export async function getAssistantMemory(db, ownerUid, assistantId) {
    const snap = await assistantMemoriesCol(db).doc(assistantId).get();
    if (!snap.exists)
        return "";
    const d = snap.data();
    if (!d || d.ownerUid !== ownerUid)
        return "";
    return d.memory ?? "";
}
export async function upsertAssistantMemory(opts) {
    const ai = getGenAI();
    const safetySettings = getGeminiSafetySettings({
        userBirthDate: opts.user.birthDate,
        userNsfwEnabled: opts.user.nsfwEnabled,
        assistantNsfwEnabled: opts.assistant.nsfwEnabled
    });
    const prompt = [
        `Stai mantenendo una MEMORIA a lungo termine per un assistente AI.`,
        `Obiettivo: aggiornare una memoria breve ma utile che cresca nel tempo.`,
        `Regole:`,
        `- Scrivi in italiano.`,
        `- Salva solo informazioni STABILI e utili per conversazioni future (preferenze, fatti ricorrenti, confini, progetti).`,
        `- Evita dettagli temporanei o "usa e getta".`,
        `- Se l'informazione è incerta, NON inserirla come fatto.`,
        `- Formato: elenco puntato breve (max 1200 caratteri).`,
        ``,
        `Assistente: ${opts.assistant.name} ${opts.assistant.surname} (relazione: ${opts.assistant.relationship})`,
        ``,
        `MEMORIA ATTUALE:`,
        opts.currentMemory?.trim() ? opts.currentMemory.trim() : "(vuota)",
        ``,
        `NUOVO DELTA (da integrare se utile):`,
        opts.newConversationDelta.trim(),
        ``,
        `Output: solo la nuova memoria aggiornata, senza titolo.`
    ].join("\n");
    const resp = await ai.models.generateContent({
        model: env.GEMINI_TEXT_MODEL,
        contents: prompt,
        config: { safetySettings }
    });
    const raw = resp.candidates?.[0]?.content?.parts
        ?.map((pp) => pp.text)
        .filter(Boolean)
        .join("") ?? "";
    const nextMemory = sanitizeForJson(raw).trim().slice(0, 1400);
    const ref = assistantMemoriesCol(opts.db).doc(opts.assistant.id);
    const existing = await ref.get();
    const createdAt = existing.exists ? (existing.data()?.createdAt ?? nowIso()) : nowIso();
    const doc = {
        assistantId: opts.assistant.id,
        ownerUid: opts.ownerUid,
        memory: nextMemory,
        createdAt,
        updatedAt: nowIso()
    };
    await ref.set(doc, { merge: true });
    return nextMemory;
}
