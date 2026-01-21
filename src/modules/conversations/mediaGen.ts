// src/modules/conversations/mediaGen.ts
import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { uploadBytesToStorage } from "../../shared/utils/storage.js";
import type { UserProfile } from "../users/userRepo.js";
import type { AssistantDoc } from "../assistants/assistantsRepo.js";
import { getStorage } from "../../config/firebase.js";

function newId() {
  return crypto.randomUUID();
}

function normalizeVeoModelName(model: string) {
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

async function readStoragePathAsBase64(bucketName: string, objectPath: string): Promise<{ base64: string }> {
  const bucket = getStorage().bucket(bucketName);
  const [buf] = await bucket.file(objectPath).download();
  return { base64: Buffer.from(buf).toString("base64") };
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
    // ✅ Niente base64: usa fileData con URL (più stabile e coerente col nuovo sistema allegati)
    resp = await ai.models.generateContent({
      model: env.GEMINI_IMAGE_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: opts.prompt },
            {
              fileData: {
                fileUri: opts.assistant.avatar!.downloadUrl,
                mimeType: opts.assistant.avatar!.contentType || "image/png"
              }
            }
          ]
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
    // ✅ Preferisci leggere direttamente dallo storage (meno fragile di fetch su URL con token)
    let base64: string;
    try {
      const a = opts.assistant.avatar!;
      const r = await readStoragePathAsBase64(a.bucket, a.path);
      base64 = r.base64;
    } catch {
      const a = opts.assistant.avatar!;
      const fetched = await fetchAsBase64(a.downloadUrl);
      base64 = fetched.base64;
    }

    operation = await ai.models.generateVideos({
      model,
      prompt: opts.prompt,
      image: { imageBytes: base64, mimeType: "image/png" },
      config: { safetySettings }
    });
  } else {
    operation = await ai.models.generateVideos({
      model,
      prompt: opts.prompt,
      config: { safetySettings }
    });
  }

  // Polling operation
  let tries = 0;
  while (!operation?.done) {
    tries++;
    if (tries > 120) throw new Error("VIDEO_GENERATION_TIMEOUT");
    await new Promise((r) => setTimeout(r, 10_000));
    operation = await ai.operations.getVideosOperation({ operation });
  }

  const videoFile = operation?.response?.generatedVideos?.[0]?.video;
  if (!videoFile) throw new Error("VIDEO_GENERATION_FAILED_NO_VIDEO");

  // ✅ FIX: ai.files.download vuole { file: file.name, downloadPath }
  const fileName: string | undefined =
    typeof videoFile === "string" ? videoFile : (videoFile.name as string | undefined);

  if (!fileName) throw new Error("VIDEO_GENERATION_FAILED_NO_FILE_NAME");

  const tmpPath = `/tmp/${newId()}.mp4`;
  await ai.files.download({ file: fileName, downloadPath: tmpPath });

  const fs = await import("node:fs/promises");
  const bytes = await fs.readFile(tmpPath).finally(async () => {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore
    }
  });

  const path = `conversations/${opts.ownerUid}/${opts.conversationId}/videos/${newId()}.mp4`;
  return uploadBytesToStorage({ path, bytes: Buffer.from(bytes), contentType: "video/mp4" });
}
