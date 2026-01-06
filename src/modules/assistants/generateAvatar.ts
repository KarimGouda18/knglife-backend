// src/modules/assistants/generateAvatar.ts
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import type { AvatarSpec, AssistantAvatar } from "./assistantsRepo.js";
import { uploadBytesToStorage } from "../../shared/utils/storage.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";

function buildAvatarPrompt(opts: {
  age: number;
  gender: string;
  avatarSpec: AvatarSpec;
  allowExplicit: boolean;
}) {
  const s = opts.avatarSpec;

  const clothingNote = opts.allowExplicit
    ? "Clothing can be minimal or nude if coherent with the character and the specs of the avatar, and should be considered only if explicitly asked."
    : "Clothing must be fully non-explicit (everyday wear). No nudity.";

  return [
    `Create a realistic portrait photo of a person.`,
    `Subject details:`,
    `- Age: ${opts.age} (adult if explicit allowed)`,
    `- Gender presentation: ${opts.gender}`,
    `- Ethnicity: ${s.ethnicity}`,
    `- Body type: ${s.bodyType}`,
    `- Hair: ${s.hairStyle}, color ${s.hairColor}`,
    `- Eyes: ${s.eyeColor}`,
    `- Clothing style: ${s.clothingStyle}`,
    ``,
    `Composition: portrait, full body, neutral background, natural lighting, photorealistic.`,
    clothingNote,
    `Do NOT add text, logos, watermarks.`
  ].join("\n");
}

export async function generateAndUploadAssistantAvatar(opts: {
  ownerUid: string;
  assistantId: string;
  age: number;
  gender: string;
  avatarSpec: AvatarSpec;
  assistantNsfwEnabled: boolean;
  user: { birthDate: string | null; nsfwEnabled: boolean };
}): Promise<AssistantAvatar> {
  const ai = getGenAI();

  const safetySettings = getGeminiSafetySettings({
    userBirthDate: opts.user.birthDate,
    userNsfwEnabled: opts.user.nsfwEnabled,
    assistantNsfwEnabled: opts.assistantNsfwEnabled
  });

  const allowExplicit = safetySettings[0]?.threshold === "BLOCK_NONE";

  const prompt = buildAvatarPrompt({
    age: opts.age,
    gender: opts.gender,
    avatarSpec: opts.avatarSpec,
    allowExplicit
  });

  const response = await ai.models.generateContent({
    model: env.GEMINI_IMAGE_MODEL,
    contents: prompt,
    config: {
      safetySettings,
      imageConfig: {
        aspectRatio: "1:1",
        imageSize: "1K"
      }
    }
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((p: any) => p.inlineData?.data);
  if (!inline?.inlineData?.data) {
    throw new Error("IMAGE_GENERATION_FAILED_NO_INLINE_DATA");
  }

  const buffer = Buffer.from(inline.inlineData.data, "base64");

  const path = `avatars/${opts.ownerUid}/${opts.assistantId}/avatar.png`;
  const uploaded = await uploadBytesToStorage({
    path,
    bytes: buffer,
    contentType: "image/png"
  });

  return {
    bucket: uploaded.bucket,
    path: uploaded.path,
    contentType: uploaded.contentType,
    size: uploaded.size,
    downloadUrl: uploaded.downloadUrl
  };
}
