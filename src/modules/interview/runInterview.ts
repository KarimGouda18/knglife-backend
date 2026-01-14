// src/modules/interview/runInterview.ts
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { sanitizeForJson } from "../../shared/utils/text.js";
import type { UserProfile } from "../users/userRepo.js";
import type { InterviewMessageDoc } from "./interviewRepo.js";
import { buildInterviewSystemInstruction, guideName } from "./interviewPrompts.js";

export async function generateNextInterviewQuestion(opts: {
  user: UserProfile;
  interviewNsfwEnabled: boolean;
  messages: InterviewMessageDoc[];
}): Promise<string> {
  const ai = getGenAI();

  const safetySettings = getGeminiSafetySettings({
    userBirthDate: opts.user.birthDate,
    userNsfwEnabled: opts.interviewNsfwEnabled,
    assistantNsfwEnabled: opts.interviewNsfwEnabled
  });

  const allowExplicit = safetySettings[0]?.threshold === "BLOCK_NONE";

  // ✅ System allineato e riusabile anche dalla Live interview
  const system = buildInterviewSystemInstruction({
    user: {
      name: opts.user.name,
      surname: opts.user.surname,
      age: opts.user.age,
      gender: opts.user.gender,
      visualDisabilityLevel: opts.user.visualDisabilityLevel
    },
    interviewNsfwEnabled: opts.interviewNsfwEnabled,
    allowExplicit
  });

  const history = opts.messages
    .map((m) => `${m.role === "assistant" ? guideName() : "Utente"}: ${m.text}`)
    .join("\n");

  const prompt = [
    system,
    ``,
    `Trascrizione finora:`,
    history || "(vuota)",
    ``,
    `Ora scrivi la PROSSIMA domanda. Output: solo la domanda, niente prefazioni.`
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

export async function generateInterviewSummaryBio(opts: {
  user: UserProfile;
  interviewNsfwEnabled: boolean;
  messages: InterviewMessageDoc[];
}): Promise<string> {
  const ai = getGenAI();

  const safetySettings = getGeminiSafetySettings({
    userBirthDate: opts.user.birthDate,
    userNsfwEnabled: opts.interviewNsfwEnabled,
    assistantNsfwEnabled: opts.interviewNsfwEnabled
  });

  const allowExplicit = safetySettings[0]?.threshold === "BLOCK_NONE";

  const transcript = opts.messages
    .map((m) => `${m.role === "assistant" ? guideName() : "Utente"}: ${m.text}`)
    .join("\n");

  const prompt = [
    `Genera una BIO in italiano come riepilogo dell'intervista qui sotto.`,
    `Stile: utile, concreta, naturale, non generica. Max 3000 caratteri.`,
    `La bio deve essere adatta a KNGLife e descrivere la persona, i suoi interessi, obiettivi, routine e preferenze.`,
    allowExplicit
      ? `NSFW ON: puoi includere anche aspetti intimi/relazionali emersi nell'intervista, senza volgarità gratuita.`
      : `NSFW OFF: evita dettagli espliciti.`,
    ``,
    `Dati precompilati:`,
    `- Nome: ${opts.user.name} ${opts.user.surname}`,
    `- Età: ${opts.user.age ?? "n/d"}`,
    `- Genere: ${opts.user.gender ?? "n/d"}`,
    `- Disabilità visiva: ${opts.user.visualDisabilityLevel}`,
    ``,
    `Trascrizione:`,
    transcript || "(vuota)",
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
