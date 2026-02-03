// src/modules/conversations/runConversation.ts
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { sanitizeForJson } from "../../shared/utils/text.js";
function nowRomeHuman() {
    return new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" });
}
function buildSystemContext(opts) {
    const payload = { user: opts.user, assistant: opts.assistant };
    const mem = (opts.assistantMemory ?? "").trim();
    const recall = (opts.recallText ?? "").trim();
    const summary = (opts.conversationSummary ?? "").trim();
    return [
        `Sei "${opts.assistant.name} ${opts.assistant.surname}".`,
        `Questa è una chat dentro KNGLife.`,
        `Data e ora correnti (Europe/Rome): ${nowRomeHuman()} (ISO: ${new Date().toISOString()})`,
        `Regole:`,
        `- Rispondi in italiano.`,
        `- Sii coerente con età/genere/relazione dell'assistente.`,
        `- Se l'utente carica allegati, analizzali e rispondi.`,
        `- Se NON riesci a leggere un allegato, devi dirlo chiaramente e spiegare cosa ti serve.`,
        `- Non restituire mai una risposta vuota.`,
        ``,
        `MEMORIA A LUNGO TERMINE (assistente):`,
        mem || "(vuota)",
        ``,
        `RIASSUNTO CONVERSAZIONE CORRENTE:`,
        summary || "(vuoto)",
        ``,
        `RICHIAMI DA CONVERSAZIONI PRECEDENTI (se utili):`,
        recall || "(nessuno)",
        ``,
        `Profili (JSON):`,
        JSON.stringify(payload)
    ].join("\n");
}
function normalizeInlineBase64(input) {
    const idx = input.indexOf("base64,");
    if (idx >= 0)
        return input.slice(idx + "base64,".length).trim();
    return input.trim();
}
function toGeminiRole(role) {
    return role === "assistant" ? "model" : "user";
}
function mapPartsToGemini(parts) {
    return parts.map((p) => {
        if (p.type === "text")
            return { text: p.text };
        if (p.type === "inline_data") {
            return {
                inlineData: {
                    mimeType: p.mimeType,
                    data: normalizeInlineBase64(p.dataBase64)
                }
            };
        }
        if (p.type === "file_url") {
            return {
                fileData: {
                    fileUri: p.url,
                    mimeType: p.mimeType
                }
            };
        }
        return { text: "" };
    });
}
function extractTextFromResp(resp) {
    const text = resp?.candidates?.[0]?.content?.parts
        ?.map((p) => p?.text)
        .filter(Boolean)
        .join("") ?? "";
    return typeof text === "string" ? text : "";
}
export async function runConversation(opts) {
    const ai = getGenAI();
    const safetySettings = getGeminiSafetySettings({
        userBirthDate: opts.userProfile.birthDate,
        userNsfwEnabled: opts.userProfile.nsfwEnabled,
        assistantNsfwEnabled: opts.assistant.nsfwEnabled
    });
    const systemText = buildSystemContext({
        user: {
            name: opts.userProfile.name,
            surname: opts.userProfile.surname,
            birthDate: opts.userProfile.birthDate,
            age: opts.userProfile.age,
            gender: opts.userProfile.gender,
            visualDisabilityLevel: opts.userProfile.visualDisabilityLevel,
            bio: opts.userProfile.bio,
            nsfwEnabled: opts.userProfile.nsfwEnabled
        },
        assistant: {
            id: opts.assistant.id,
            name: opts.assistant.name,
            surname: opts.assistant.surname,
            age: opts.assistant.age,
            gender: opts.assistant.gender,
            relationship: opts.assistant.relationship,
            bio: opts.assistant.bio,
            nsfwEnabled: opts.assistant.nsfwEnabled,
            avatarSpec: opts.assistant.avatarSpec,
            persona: opts.assistant.persona ?? null
        },
        assistantMemory: opts.assistantMemory,
        recallText: opts.recallText,
        conversationSummary: opts.conversationSummary
    });
    const contents = [
        { role: "user", parts: [{ text: systemText }] },
        ...opts.history.map((m) => ({
            role: toGeminiRole(m.role),
            parts: mapPartsToGemini(m.parts)
        }))
    ];
    const resp = await ai.models.generateContent({
        model: env.GEMINI_TEXT_MODEL,
        contents,
        config: {
            safetySettings,
            tools: [{ googleSearch: {} }]
        }
    });
    const raw = extractTextFromResp(resp);
    const cleaned = sanitizeForJson(raw).trim();
    if (!cleaned) {
        const finishReason = resp?.candidates?.[0]?.finishReason ?? null;
        const promptFeedback = resp?.promptFeedback ?? null;
        const safetyRatings = resp?.candidates?.[0]?.safetyRatings ?? null;
        throw new Error(`EMPTY_MODEL_RESPONSE: finishReason=${JSON.stringify(finishReason)} promptFeedback=${JSON.stringify(promptFeedback)} safetyRatings=${JSON.stringify(safetyRatings)}`);
    }
    return cleaned;
}
