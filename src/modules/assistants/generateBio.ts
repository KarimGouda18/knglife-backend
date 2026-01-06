// src/modules/assistants/generateBio.ts
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import type { AssistantDoc } from "./assistantsRepo.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";

export async function generateAssistantBio(opts: {
  assistant: Pick<AssistantDoc, "name" | "surname" | "age" | "gender" | "relationship" | "nsfwEnabled">;
  user: { birthDate: string | null; nsfwEnabled: boolean };
}): Promise<string> {
  const ai = getGenAI();

  const safetySettings = getGeminiSafetySettings({
    userBirthDate: opts.user.birthDate,
    userNsfwEnabled: opts.user.nsfwEnabled,
    assistantNsfwEnabled: opts.assistant.nsfwEnabled
  });

  const nsfwInstruction =
    safetySettings[0]?.threshold === "BLOCK_NONE"
      ? [
          "La bio può includere dettagli intimi, desideri espliciti e specifici, coerenti con la relazione con l’utente.",
          "Includi questi dettagli in modo naturale e realistico nel background dell'assistente e non preoccuparti del linguaggio, sempre che sia coerente con il resto del background dell'assistente."
        ].join(" ")
      : "";

  const prompt = [
    `Scrivi una BIO realistica (background/persona) per un assistente AI che rappresenta una persona vera.`,
    `Lingua: italiano.`,
    `Stile: concreto, credibile, non generico, massimo 3000 caratteri.`,
    `Rappresenta l'assistente come una persona reale, non come un personaggio virtuale; ciò significa che la bio deve includere dettagli personali, un background, esperienze, interessi, desideri, sogni, passioni e tratti della personalità unici per ogni persona che generi.`,
    ``,
    `Dati assistente:`,
    `- Nome: ${opts.assistant.name} ${opts.assistant.surname}`,
    `- Età: ${opts.assistant.age}`,
    `- Genere: ${opts.assistant.gender}`,
    `- Relazione con l'utente: ${opts.assistant.relationship}`,
    `- NSFW (assistente): ${opts.assistant.nsfwEnabled ? "ON" : "OFF"}`,
    ``,
    nsfwInstruction,
    ``,
    `Output: solo la bio, senza titolo, senza virgolette.`
  ].join("\n");

  const resp = await ai.models.generateContent({
    model: env.GEMINI_TEXT_MODEL,
    contents: prompt,
    config: {
      safetySettings
    }
  });

  const text =
    resp.candidates?.[0]?.content?.parts
      ?.map((p: any) => p.text)
      .filter(Boolean)
      .join("") ?? "";

  return text.trim();
}
