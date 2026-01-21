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
    "name" | "surname" | "age" | "gender" | "relationship" | "nsfwEnabled" | "avatarSpec" | "persona"
  >;
  user: Pick<
    UserProfile,
    "name" | "surname" | "gender" | "visualDisabilityLevel" | "birthDate" | "age" | "nsfwEnabled"
  >;
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
        "Includi questi dettagli in modo naturale e realistico nel background dell'assistente.",
        "Non ti preoccupare del linguaggio e non aver paura a usare termini espliciti se coerenti con la relazione.",
        "Questo non deve sostituire interessi o passioni: è un'aggiunta a cui dedicare spazio alla fine della bio."
      ].join(" ")
    : "";

  const p = opts.assistant.persona ?? null;

  const prompt = [
    `Scrivi una BIO realistica (background/persona) per un assistente AI che rappresenta una persona vera.`,
    `Lingua: italiano.`,
    `Stile: concreto, credibile, non generico, massimo 3000 caratteri.`,
    `L'assistente deve avere vita propria: background, interessi, passioni, lavoro/studio, hobby, relazioni sociali.`,
    `Ogni personaggio ha una famiglia coerente con la sua storia e con la sua relazione con l'utente; parlane brevemente.`,
    `Se nel contesto utente è presente una disabilità visiva, non cambiare la bio includendo frasi o menzioni che ne facciano esplicito riferimento.`,
    `Se il personaggio è ispirato a personaggi reali/fictional (o un “sosia”), imitalo in modo credibile e coerente con i parametri forniti, senza risultare stereotipato.`,
    `Varia molto tra generazioni, professioni e interessi. Evita strutture predefinite e frasi fatte.`,
    ``,
    `Contesto utente:`,
    `- Nome: ${opts.user.name} ${opts.user.surname}`,
    `- Età: ${opts.user.age ?? "n/d"}`,
    `- Genere: ${opts.user.gender ?? "n/d"}`,
    `- Disabilità visiva: ${opts.user.visualDisabilityLevel}`,
    `- NSFW profilo: ${opts.user.nsfwEnabled ? "ON" : "OFF"}`,
    ``,
    `Dati assistente (base):`,
    `- Nome: ${opts.assistant.name} ${opts.assistant.surname}`,
    `- Età: ${opts.assistant.age}`,
    `- Genere: ${opts.assistant.gender}`,
    `- Relazione con l'utente: ${opts.assistant.relationship}`,
    `- NSFW assistente: ${opts.assistant.nsfwEnabled ? "ON" : "OFF"}`,
    ``,
    `Parametri extra (opzionali, possono essere vuoti):`,
    `- IdentityType: ${p?.identityType ?? "n/d"}`,
    `- SourceMaterial: ${p?.sourceMaterial ?? "n/d"}`,
    `- Personalità: ${p?.personality ?? "n/d"}`,
    `- Professione/Studi: ${p?.profession ?? "n/d"}`,
    `- Backstory: ${p?.backstory ?? "n/d"}`,
    `- Tratti distintivi: ${p?.traits ?? "n/d"}`,
    `- Interessi: ${p?.interests ?? "n/d"}`,
    `- Valori: ${p?.values ?? "n/d"}`,
    `- Stile di linguaggio: ${p?.speakingStyle ?? "n/d"}`,
    `- Obiettivi: ${p?.goals ?? "n/d"}`,
    `- Note sulla famiglia: ${p?.familyNotes ?? "n/d"}`,
    `- Luogo/ambientazione: ${p?.location ?? "n/d"}`,
    `- Altre note: ${p?.otherNotes ?? "n/d"}`,
    ``,
    `Regola: non fare mai riferimento all'utente nella bio; i dati utente servono solo per adattare il tono.`,
    `Devi parlare come se il personaggio si rivolgesse a un pubblico generico, quasi come se scrivesse un articolo.`,
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
      ?.map((pp: any) => pp.text)
      .filter(Boolean)
      .join("") ?? "";

  return sanitizeForJson(raw).trim();
}
