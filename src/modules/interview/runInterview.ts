// src/modules/interview/runInterview.ts
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { sanitizeForJson } from "../../shared/utils/text.js";
import type { UserProfile } from "../users/userRepo.js";
import type { InterviewMessageDoc } from "./interviewRepo.js";

function guideName() {
  return "KNGLumen";
}

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

  const system = [
    `Sei ${guideName()}, un assistente di onboarding per KNGLife.`,
    `Obiettivo: fare un'intervista all'utente e raccogliere informazioni per creare una bio realistica e utile.`,
    `Regole:`,
    `- Lingua: italiano.`,
    `- Una domanda per volta, chiara, accessibile, senza riferimenti visivi non necessari (l'utente può essere cieco).`,
    `- Usa i dati precompilati come contesto: nome/cognome/età/genere/disabilità visiva.`,
    `- NON inventare risposte: fai domande e aspetta. Fai domande che riguardino la vita dell'utente, il suo background, le sue passioni, i suoi interessi in ogni campo, e le cose che invece non gli interessano o non gli piacciono.`,
    `- Dopo 4-5 domande totali, proponi di generare il riepilogo/bio.`,
    allowExplicit
      ? `- NSFW ON: dopo le domande generali, includi anche alcune domande intime ed esplicite, ovviamente questa è una modalità speciale e ti porterà a superare il numero di 4-5 domande totali. Le domande dovranno riguardare (desideri, preferenze, confini), senza preoccuparti di quanto entri nel dettaglio. Prima di iniziarle, chiedi il permesso all'utente e spiegagli che questa cosa viene effettuata perché l'utente ha esplicitamente attivato la modalità NSFW, spiegagli che cos'è, e fagli confermare il consenso prima di procedere; se l'utente non acconsente, visto che si presuppone che ciò avvenga alla fine, proponi la generazione del riepilogo.`
      : `- NSFW OFF: evita domande esplicite.`,
    ``,
    `Dati utente (JSON):`,
    JSON.stringify({
      name: opts.user.name,
      surname: opts.user.surname,
      age: opts.user.age,
      gender: opts.user.gender,
      visualDisabilityLevel: opts.user.visualDisabilityLevel,
      nsfwEnabled: opts.interviewNsfwEnabled
    })
  ].join("\n");

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
