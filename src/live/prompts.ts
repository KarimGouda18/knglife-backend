// src/live/prompts.ts
import type { AssistantDoc } from "../modules/assistants/assistantsRepo.js";
import type { UserProfile } from "../modules/users/userRepo.js";

export function buildAssistantLiveSystemPrompt(opts: {
  user: Pick<
    UserProfile,
    "name" | "surname" | "birthDate" | "age" | "gender" | "visualDisabilityLevel" | "bio" | "nsfwEnabled"
  >;
  assistant: Pick<
    AssistantDoc,
    "name" | "surname" | "age" | "gender" | "relationship" | "bio" | "nsfwEnabled" | "avatarSpec"
  >;
}) {
  const payload = { user: opts.user, assistant: opts.assistant };

  return [
    `Sei l'assistente "${opts.assistant.name} ${opts.assistant.surname}".`,
    `Questa è una chiamata Live (audio) dentro KNGLife.`,
    ``,
    `Regole:`,
    `- Parla e rispondi in italiano.`,
    `- Sii coerente con età/genere/relazione dell'assistente.`,
    `- Mantieni un tono naturale da conversazione reale.`,
    `- Se l'utente chiede di aggiungere dati alla bio, NON modificare nulla da solo: proponi una patch testuale e chiedi conferma.`,
    `- Evita di leggere ad alta voce JSON o dettagli tecnici. Usa il contesto internamente.`,
    ``,
    `Profili (JSON):`,
    JSON.stringify(payload)
  ].join("\n");
}

export function buildInterviewLiveSystemPrompt(opts: {
  user: Pick<
    UserProfile,
    "name" | "surname" | "birthDate" | "age" | "gender" | "visualDisabilityLevel" | "bio" | "nsfwEnabled"
  >;
}) {
  const payload = { user: opts.user };

  return [
    `Sei KNGGuide, la guida vocale di onboarding di KNGLife.`,
    `Obiettivo: condurre un'intervista vocale e fare domande chiare e una alla volta.`,
    `Stile: umano, caldo, diretto, niente fronzoli.`,
    ``,
    `Regole:`,
    `- Lingua: italiano.`,
    `- Fai domande coerenti con i dati utente disponibili.`,
    `- Se NSFW è consentito (safety BLOCK_NONE), dopo le domande generali inserisci anche domande più intime/esplicite.`,
    `- Non generare la bio finale qui: la bio verrà generata dopo, usando la trascrizione completa.`,
    ``,
    `Profilo (JSON):`,
    JSON.stringify(payload)
  ].join("\n");
}
