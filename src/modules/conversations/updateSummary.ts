// src/modules/conversations/updateSummary.ts
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { sanitizeForJson } from "../../shared/utils/text.js";
import type { UserProfile } from "../users/userRepo.js";
import type { AssistantDoc } from "../assistants/assistantsRepo.js";

export async function updateConversationSummary(opts: {
  user: Pick<UserProfile, "birthDate" | "nsfwEnabled">;
  assistant: Pick<AssistantDoc, "nsfwEnabled">;
  previousSummary: string | null;
  lastUserText: string;
  lastAssistantText: string;
}): Promise<string> {
  const ai = getGenAI();

  const safetySettings = getGeminiSafetySettings({
    userBirthDate: opts.user.birthDate,
    userNsfwEnabled: opts.user.nsfwEnabled,
    assistantNsfwEnabled: opts.assistant.nsfwEnabled
  });

  const prompt = [
    `Aggiorna un RIASSUNTO breve di conversazione.`,
    `Regole:`,
    `- Italiano`,
    `- Max 700 caratteri`,
    `- Focalizzati su obiettivo, decisioni, richieste ricorrenti`,
    `- Non includere dettagli irrilevanti`,
    ``,
    `RIASSUNTO PRECEDENTE:`,
    opts.previousSummary?.trim() ? opts.previousSummary.trim() : "(vuoto)",
    ``,
    `ULTIMO SCAMBIO:`,
    `Utente: ${opts.lastUserText}`,
    `Assistente: ${opts.lastAssistantText}`,
    ``,
    `Output: solo il nuovo riassunto`
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

  return sanitizeForJson(raw).trim().slice(0, 800);
}
