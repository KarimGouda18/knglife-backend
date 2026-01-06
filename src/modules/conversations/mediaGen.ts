// src/modules/conversations/mediaGen.ts
import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { uploadBytesToStorage } from "../../shared/utils/storage.js";
import type { UserProfile } from "../users/userRepo.js";
import type { AssistantDoc } from "../assistants/assistantsRepo.js";

function newId() {
  return crypto.randomUUID();
}

function normalizeVeoModelName(model: string) {
  // Permette di usare "veo-3.1" in env senza rompere tutto:
  // se il tuo account accetta già "veo-3.1" allora non cambia nulla,
  // ma se richiede il suffisso generate-preview, lo aggiunge.
  if (model === "veo-3.1") return "veo-3.1-generate-preview";
  return model;
}

async function fetchAsBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FETCH_REFERENCE_IMAGE_FAILED: ${res.status} ${res.statusText}`);
  const mimeType = res.headers.get("content-type") || "image/jpeg";
  const ab = await res.arrayBuffer();
  return { base64: Buffer.from(ab).toString("base64"), mimeType };
}

function guessImageExt(mime: string) {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}

export async function generateConversationImage(opts: {
  ownerUid: string;
  conversationId: string;
  prompt: string;

  user: Pick<UserProfile, "birthDate" | "nsfwEnabled">;
  assistant: Pick<AssistantDoc, "nsfwEnabled" | "avatar">;

  useAssistantAvatar?: boolean;
}) {
  const ai = getGenAI();

  const safetySettings = getGeminiSafetySettings({
    userBirthDate: opts.user.birthDate,
    userNsfwEnabled: opts.user.nsfwEnabled,
    assistantNsfwEnabled: opts.assistant.nsfwEnabled
  });

  const hasAvatar = !!opts.assistant.avatar?.downloadUrl;
  const useRef = !!opts.useAssistantAvatar && hasAvatar;

  let resp: any;

  if (useRef) {
    const { base64, mimeType } = await fetchAsBase64(opts.assistant.avatar!.downloadUrl);

    resp = await ai.models.generateContent({
      model: env.GEMINI_IMAGE_MODEL,
      contents: [
        {
          role: "user",
          parts: [{ text: opts.prompt }, { inlineData: { data: base64, mimeType } }]
        }
      ],
      config: {
        responseModalities: ["IMAGE"],
        safetySettings
      }
    });
  } else {
    resp = await ai.models.generateContent({
      model: env.GEMINI_IMAGE_MODEL,
      contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
      config: {
        responseModalities: ["IMAGE"],
        safetySettings
      }
    });
  }

  // Supportiamo più forme di risposta possibili (SDK cambia spesso forma tra preview)
  const bytesBase64: string | undefined =
    resp?.generatedImages?.[0]?.image?.imageBytes ??
    resp?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData?.data;

  const mimeType: string =
    resp?.generatedImages?.[0]?.image?.mimeType ??
    resp?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData?.mimeType ??
    "image/png";

  if (!bytesBase64) throw new Error("IMAGE_GENERATION_FAILED_NO_BYTES");

  const bytes = Buffer.from(bytesBase64, "base64");
  const ext = guessImageExt(mimeType);

  const path = `conversations/${opts.ownerUid}/${opts.conversationId}/images/${newId()}.${ext}`;
  return uploadBytesToStorage({ path, bytes, contentType: mimeType });
}

export async function generateConversationVideo(opts: {
  ownerUid: string;
  conversationId: string;
  prompt: string;

  user: Pick<UserProfile, "birthDate" | "nsfwEnabled">;
  assistant: Pick<AssistantDoc, "nsfwEnabled" | "avatar">;

  useAssistantAvatar?: boolean;
}) {
  const ai = getGenAI();

  const safetySettings = getGeminiSafetySettings({
    userBirthDate: opts.user.birthDate,
    userNsfwEnabled: opts.user.nsfwEnabled,
    assistantNsfwEnabled: opts.assistant.nsfwEnabled
  });

  const model = normalizeVeoModelName(env.VEO_VIDEO_MODEL);

  const hasAvatar = !!opts.assistant.avatar?.downloadUrl;
  const useRef = !!opts.useAssistantAvatar && hasAvatar;

  let operation: any;

  if (useRef) {
    const { base64, mimeType } = await fetchAsBase64(opts.assistant.avatar!.downloadUrl);

    operation = await ai.models.generateVideos({
      model,
      prompt: opts.prompt,
      image: { imageBytes: base64, mimeType },
      config: { safetySettings }
    });
  } else {
    operation = await ai.models.generateVideos({
      model,
      prompt: opts.prompt,
      config: { safetySettings }
    });
  }

  while (!operation?.done) {
    await new Promise((r) => setTimeout(r, 10_000));
    operation = await ai.operations.getVideosOperation({ operation });
  }

  const videoFile = operation?.response?.generatedVideos?.[0]?.video;
  if (!videoFile) throw new Error("VIDEO_GENERATION_FAILED_NO_VIDEO");

  const tmpPath = `/tmp/${newId()}.mp4`;
  await ai.files.download({ file: videoFile, downloadPath: tmpPath });

  const bytes = await import("node:fs/promises").then((fs) => fs.readFile(tmpPath));

  const path = `conversations/${opts.ownerUid}/${opts.conversationId}/videos/${newId()}.mp4`;
  return uploadBytesToStorage({ path, bytes: Buffer.from(bytes), contentType: "video/mp4" });
}
