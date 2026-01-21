// src/modules/conversations/runConversation.ts
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { sanitizeForJson } from "../../shared/utils/text.js";
import type { MessagePart } from "./conversationsRepo.js";
import type { UserProfile } from "../users/userRepo.js";
import type { AssistantDoc } from "../assistants/assistantsRepo.js";

function nowRomeHuman() {
  return new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" });
}

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
    `Sei "${opts.assistant.name} ${opts.assistant.surname}".`,
    `Questa è una chat dentro KNGLife.`,
    `Data e ora correnti (Europe/Rome): ${nowRomeHuman()} (ISO: ${new Date().toISOString()})`,
    `Regole:`,
    `- Rispondi in italiano.`,
    `- Sii coerente con età/genere/relazione dell'assistente.`,
    `- Se l'utente carica allegati, analizzali e rispondi.`,
    `- Se l'utente chiede di aggiungere dati alla bio, NON modificare nulla da solo: proponi una patch testuale e attendi conferma.`,
    ``,
    `Profili (JSON):`,
    JSON.stringify(payload)
  ].join("\n");
}

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

    if (p.type === "inline_data") {
      return {
        inlineData: {
          mimeType: p.mimeType,
          data: normalizeInlineBase64(p.dataBase64)
        }
      };
    }

    if (p.type === "file_url") {
      // ✅ Gemini NON accetta displayName in fileData/file_data (era il tuo 400)
      return {
        fileData: {
          fileUri: p.url,
          mimeType: p.mimeType
        }
      };
    }

    return { text: "" };
  });
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
