// src/modules/conversations/generateTitle.ts
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { sanitizeForJson } from "../../shared/utils/text.js";
export async function generateConversationTitle(opts) {
    const ai = getGenAI();
    const safetySettings = getGeminiSafetySettings({
        userBirthDate: opts.user.birthDate,
        userNsfwEnabled: opts.user.nsfwEnabled,
        assistantNsfwEnabled: opts.assistant.nsfwEnabled
    });
    const prompt = [
        `Genera un TITOLO breve e informativo per una conversazione.`,
        `Regole:`,
        `- Italiano`,
        `- Massimo 45 caratteri`,
        `- Niente virgolette`,
        `- Niente emoji`,
        `- Deve descrivere l'argomento principale`,
        ``,
        `Testo utente: ${opts.firstUserText}`,
        `Risposta assistente: ${opts.firstAssistantText}`,
        ``,
        `Output: solo il titolo`
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
    const title = sanitizeForJson(raw).trim().replace(/^["'“”]+|["'“”]+$/g, "");
    return (title || "Conversazione").slice(0, 60);
}
