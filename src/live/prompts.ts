// src/live/prompts.ts
import type { AssistantDoc } from "../modules/assistants/assistantsRepo.js";
import type { UserProfile } from "../modules/users/userRepo.js";

function normalizeSpaces(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Builds the system prompt for a live (audio/video) assistant session.
 * The prompt instructs the model to embody the assistant persona and
 * provides long-term memory, conversation summary, and cross-session recall.
 */
export function buildAssistantLiveSystemPrompt(opts: {
  user: Pick<
    UserProfile,
    "name" | "surname" | "birthDate" | "age" | "gender" | "visualDisabilityLevel" | "bio" | "nsfwEnabled"
  >;
  assistant: Pick<
    AssistantDoc,
    "id" | "name" | "surname" | "age" | "gender" | "relationship" | "bio" | "nsfwEnabled" | "avatarSpec" | "persona"
  >;
  assistantMemory: string;
  recallText: string;
  conversationSummary: string | null;
}) {
  const mem = normalizeSpaces(opts.assistantMemory || "");
  const recall = (opts.recallText || "").trim();
  const sum = normalizeSpaces(opts.conversationSummary || "");

  return [
    `Sei "${opts.assistant.name} ${opts.assistant.surname}".`,
    `Sei in una sessione VOCALE (Live) di KNGLife.`,
    `Regole:`,
    `- Parla in italiano.`,
    `- Risposte concise, naturali, utili.`,
    `- Coerenza con relazione/età/genere e profilo assistente.`,
    `- Non fare l'assistente “vuoto”: se non capisci chiedi chiarimenti.`,
    ``,
    `MEMORIA A LUNGO TERMINE (assistente):`,
    mem || "(vuota)",
    ``,
    `RIASSUNTO CONVERSAZIONE CORRENTE:`,
    sum || "(vuoto)",
    ``,
    `RICHIAMI DA CONVERSAZIONI PRECEDENTI (se utili):`,
    recall || "(nessuno)",
    ``,
    `Profili (JSON):`,
    JSON.stringify({ user: opts.user, assistant: opts.assistant })
  ].join("\n");
}

