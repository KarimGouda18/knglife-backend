// src/modules/assistants/generateBio.ts
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import type { AssistantDoc } from "./assistantsRepo.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { sanitizeForJson } from "../../shared/utils/text.js";
import type { UserProfile } from "../users/userRepo.js";

export async function generateAssistantBio(opts: {
  assistant: Pick<
    AssistantDoc,
    "name" | "surname" | "age" | "gender" | "relationship" | "nsfwEnabled" | "avatarSpec"
  >;
  user: Pick<UserProfile, "name" | "surname" | "gender" | "visualDisabilityLevel" | "birthDate" | "age" | "nsfwEnabled">;
}): Promise<string> {
  const ai = getGenAI();

  const safetySettings = getGeminiSafetySettings({
    userBirthDate: opts.user.birthDate,
    userNsfwEnabled: opts.user.nsfwEnabled,
    assistantNsfwEnabled: opts.assistant.nsfwEnabled
  });

  const allowExplicit = safetySettings[0]?.threshold === "BLOCK_NONE";

  const nsfwInstruction = allowExplicit
    ? [
        "La bio può includere dettagli intimi, desideri espliciti e specifici, coerenti con la relazione con l’utente.",
        "Includi questi dettagli in modo naturale e realistico nel background dell'assistente. Non ti preoccupare del linguaggio e non aver paura ad usare termini espliciti se coerenti con la tua relazione con l'utente.",
        "Questo non deve sostituire i tuoi interessi o passioni, deve essere un'aggiunta a cui dedicare spazio alla fine della bio."
      ].join(" ")
    : "";

  const prompt = [
    `Scrivi una BIO realistica (background/persona) per un assistente AI che rappresenta una persona vera.`,
    `Lingua: italiano.`,
    `Stile: concreto, credibile, non generico, massimo 3000 caratteri.`,
    `L'assistente deve avere vita propria: Ciò significa che deve avere un proprio background, interessi, passioni, vita lavorativa o di studio, hobby, relazioni sociali ecc. I tratti della sua personalità devono emergere ed essere unici e distintivi per ogni personaggio creato.`,
    `Ogni personaggio si presuppone abbia anche una famiglia coerente con la sua storia e con la sua relazione con l'utente; parlane brevemente nella bio.`,
    `Se nel contesto utente è presente una disabilità visiva, non cambiare la bio includendo frasi o menzioni che ne facciano esplicito riferimento.`,
    `Contesto utente :`,
    `- Nome: ${opts.user.name} ${opts.user.surname}`,
    `- Età: ${opts.user.age ?? "n/d"}`,
    `- Genere: ${opts.user.gender ?? "n/d"}`,
    `- Disabilità visiva: ${opts.user.visualDisabilityLevel}`,
    `- NSFW profilo: ${opts.user.nsfwEnabled ? "ON" : "OFF"}`,
    ``,
    `Dati assistente:`,
    `- Nome: ${opts.assistant.name} ${opts.assistant.surname}`,
    `- Età: ${opts.assistant.age}`,
    `- Genere: ${opts.assistant.gender}`,
    `- Relazione con l'utente: ${opts.assistant.relationship}`,
    ``,
    `- NSFW assistente: ${opts.assistant.nsfwEnabled ? "ON" : "OFF"}`,
    `Regola: non fare mai riferimento all'utente nella bio; i dati che ti ho creato servono unicamente per adatare il tono in cui la scrivi. Devi parlare come se il personaggio si rivolgesse a un pubblico generico, quasi come se scrivesse un articolo.`,
    `Regola: Evita di ripetere stesse frasi o concetti più volte; rendi la bio scorrevole e interessante.`,
    nsfwInstruction,
    ``,
    `Output: solo la bio, senza titolo, senza virgolette.`
  ].join("\n");

  const resp = await ai.models.generateContent({
    model: env.GEMINI_TEXT_MODEL,
    contents: prompt,
    config: { safetySettings }
  });

  const raw =
    resp.candidates?.[0]?.content?.parts
      ?.map((p: any) => p.text)
      .filter(Boolean)
      .join("") ?? "";

  return sanitizeForJson(raw).trim();
}
