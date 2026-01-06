// src/modules/conversations/runConversation.ts
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { sanitizeForJson } from "../../shared/utils/text.js";
import type { MessagePart } from "./conversationsRepo.js";
import type { UserProfile } from "../users/userRepo.js";
import type { AssistantDoc } from "../assistants/assistantsRepo.js";

function buildSystemContext(opts: {
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
    `Questa è una chat dentro KNGLife.`,
    `Regole:`,
    `- Rispondi in italiano.`,
    `- Sii coerente con età/genere/relazione dell'assistente.`,
    `- Se l'utente carica allegati (inline data), analizzali e rispondi.`,
    `- Se l'utente chiede di aggiungere dati alla bio, NON modificare nulla da solo: proponi una patch testuale e attendi conferma.`,
    ``,
    `Profili (JSON):`,
    JSON.stringify(payload)
  ].join("\n");
}

export async function runConversation(opts: {
  history: { role: "user" | "assistant"; parts: MessagePart[] }[];
  userProfile: UserProfile;
  assistant: AssistantDoc;
}): Promise<string> {
  const ai = getGenAI();

  const safetySettings = getGeminiSafetySettings({
    userBirthDate: opts.userProfile.birthDate,
    userNsfwEnabled: opts.userProfile.nsfwEnabled,
    assistantNsfwEnabled: opts.assistant.nsfwEnabled
  });

  const systemText = buildSystemContext({
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
    assistant: {
      name: opts.assistant.name,
      surname: opts.assistant.surname,
      age: opts.assistant.age,
      gender: opts.assistant.gender,
      relationship: opts.assistant.relationship,
      bio: opts.assistant.bio,
      nsfwEnabled: opts.assistant.nsfwEnabled,
      avatarSpec: opts.assistant.avatarSpec
    }
  });

  const contents = [
    { role: "user" as const, parts: [{ text: systemText }] },
    ...opts.history.map((m) => ({
      role: m.role,
      parts: m.parts.map((p) =>
        p.type === "text"
          ? { text: p.text }
          : { inlineData: { mimeType: p.mimeType, data: p.dataBase64 } }
      )
    }))
  ];

  const resp = await ai.models.generateContent({
    model: env.GEMINI_TEXT_MODEL,
    contents,
    config: { safetySettings }
  });

  const raw =
    resp.candidates?.[0]?.content?.parts
      ?.map((p: any) => p.text)
      .filter(Boolean)
      .join("") ?? "";

  return sanitizeForJson(raw).trim();
}
