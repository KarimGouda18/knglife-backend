// src/modules/groups/runGroupConversation.ts
import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { sanitizeForJson } from "../../shared/utils/text.js";
import type { MessagePart } from "../conversations/conversationsRepo.js";
import type { UserProfile } from "../users/userRepo.js";
import type { AssistantDoc } from "../assistants/assistantsRepo.js";
import type { GroupDoc } from "./groupsRepo.js";

function normalizeInlineBase64(input: string) {
  const idx = input.indexOf("base64,");
  if (idx >= 0) return input.slice(idx + "base64,".length).trim();
  return input.trim();
}

function toGeminiRole(role: "user" | "assistant") {
  return role === "assistant" ? ("model" as const) : ("user" as const);
}

function mapPartsToGemini(parts: MessagePart[]) {
  return parts.map((p) => {
    if (p.type === "text") return { text: p.text };
    return {
      inlineData: {
        mimeType: p.mimeType,
        data: normalizeInlineBase64(p.dataBase64)
      }
    };
  });
}

function pickRandomOrder<T>(arr: T[]) {
  const a = [...arr];
  // Fisher-Yates shuffle con crypto
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function extractTextFromParts(parts: MessagePart[]) {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .trim();
}

/**
 * Cerca mention stile @nome o @nome cognome (case-insensitive).
 * Ritorna l'assistente matchato (prima occorrenza) oppure null.
 */
function detectMentionedAssistant(opts: { text: string; assistants: AssistantDoc[] }) {
  const t = opts.text;

  // cattura "@qualcosa" fino a 2 token (nome o nome+cognome)
  // esempio: "@Selene" oppure "@Selene Rossi"
  const re = /@([^\s@]{1,40})(?:\s+([^\s@]{1,40}))?/giu;

  const norm = (s: string) => s.toLowerCase().trim();

  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const first = norm(m[1] ?? "");
    const second = norm(m[2] ?? "");

    for (const a of opts.assistants) {
      const name = norm(a.name);
      const surname = norm(a.surname);
      const full = norm(`${a.name} ${a.surname}`);

      if (second) {
        if (first === name && second === surname) return a;
        if (norm(`${first} ${second}`) === full) return a;
      } else {
        if (first === name) return a;
        // supporto @nomecognome attaccato? (molto opzionale)
        if (first === norm(`${a.name}${a.surname}`)) return a;
      }
    }
  }

  return null;
}

function buildGroupSystemContext(opts: {
  user: Pick<
    UserProfile,
    "name" | "surname" | "birthDate" | "age" | "gender" | "visualDisabilityLevel" | "bio" | "nsfwEnabled"
  >;
  group: Pick<GroupDoc, "name" | "context">;
  assistant: Pick<
    AssistantDoc,
    "id" | "name" | "surname" | "age" | "gender" | "relationship" | "bio" | "nsfwEnabled" | "avatarSpec"
  >;
  otherAssistants: { id: string; name: string; surname: string }[];
}) {
  const payload = {
    user: opts.user,
    group: opts.group,
    assistant: opts.assistant,
    otherAssistants: opts.otherAssistants
  };

  return [
    `Sei "${opts.assistant.name} ${opts.assistant.surname}" (assistantId: ${opts.assistant.id}).`,
    `Questa è una chat di GRUPPO dentro KNGLife.`,
    `Nel gruppo ci sono più assistenti: vedrai nella cronologia anche i messaggi di altri assistenti.`,
    `Regole:`,
    `- Rispondi in italiano.`,
    `- Mantieni la tua identità e la tua bio: NON parlare come gli altri assistenti.`,
    `- Sii coerente con età/genere/relazione del tuo personaggio.`,
    `- Se l'utente carica allegati (inline data), analizzali e rispondi.`,
    `- Se l'utente chiede di aggiungere dati alla bio, NON modificare nulla da solo: proponi una patch testuale e attendi conferma.`,
    `- Se il gruppo ha un CONTEXT, usalo come tema/role e integra quel contesto nel tono e nelle scelte narrative, senza diventare ripetitivo.`,
    ``,
    `Contesto gruppo: ${opts.group.context ?? "n/d"}`,
    ``,
    `Profili (JSON):`,
    JSON.stringify(payload)
  ].join("\n");
}

async function runOneAssistantTurn(opts: {
  history: { role: "user" | "assistant"; parts: MessagePart[] }[];
  userProfile: UserProfile;
  group: GroupDoc;
  assistant: AssistantDoc;
  allAssistants: AssistantDoc[];
}): Promise<string> {
  const ai = getGenAI();

  const safetySettings = getGeminiSafetySettings({
    userBirthDate: opts.userProfile.birthDate,
    userNsfwEnabled: opts.userProfile.nsfwEnabled,
    assistantNsfwEnabled: opts.assistant.nsfwEnabled
  });

  const systemText = buildGroupSystemContext({
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
    group: { name: opts.group.name, context: opts.group.context },
    assistant: {
      id: opts.assistant.id,
      name: opts.assistant.name,
      surname: opts.assistant.surname,
      age: opts.assistant.age,
      gender: opts.assistant.gender,
      relationship: opts.assistant.relationship,
      bio: opts.assistant.bio,
      nsfwEnabled: opts.assistant.nsfwEnabled,
      avatarSpec: opts.assistant.avatarSpec
    },
    otherAssistants: opts.allAssistants
      .filter((a) => a.id !== opts.assistant.id)
      .map((a) => ({ id: a.id, name: a.name, surname: a.surname }))
  });

  const contents = [
    { role: "user" as const, parts: [{ text: systemText }] },
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

  const raw =
    resp.candidates?.[0]?.content?.parts
      ?.map((p: any) => p.text)
      .filter(Boolean)
      .join("") ?? "";

  return sanitizeForJson(raw).trim();
}

export async function runGroupConversation(opts: {
  history: { role: "user" | "assistant"; parts: MessagePart[] }[];
  lastUserParts: MessagePart[];
  userProfile: UserProfile;
  group: GroupDoc;
  assistants: AssistantDoc[];
}): Promise<
  { assistant: AssistantDoc; reply: string }[]
> {
  const lastText = extractTextFromParts(opts.lastUserParts);

  const mentioned = detectMentionedAssistant({ text: lastText, assistants: opts.assistants });

  const targets = mentioned ? [mentioned] : pickRandomOrder(opts.assistants);

  const results: { assistant: AssistantDoc; reply: string }[] = [];

  // sequenziale: ogni assistente vede la risposta di quello precedente
  let rollingHistory = [...opts.history];

  for (const a of targets) {
    const reply = await runOneAssistantTurn({
      history: rollingHistory,
      userProfile: opts.userProfile,
      group: opts.group,
      assistant: a,
      allAssistants: opts.assistants
    });

    results.push({ assistant: a, reply });

    rollingHistory = [
      ...rollingHistory,
      { role: "assistant" as const, parts: [{ type: "text", text: reply }] }
    ];
  }

  return results;
}
