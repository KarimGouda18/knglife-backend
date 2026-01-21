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

function extractFilesNameFromUri(uri: string): string | null {
  // es: https://generativelanguage.googleapis.com/v1beta/files/8bem4xshl3ac:download?alt=media
  const m = uri.match(/\/v1beta\/(files\/[^:\s\/\?]+)/);
  return m?.[1] ?? null;
}

async function fetchVideoByUri(uri: string): Promise<Buffer> {
  // Fallback robusto: scarica direttamente la URI con API key
  const res = await fetch(uri, {
    headers: { "x-goog-api-key": env.GEMINI_API_KEY }
  });
  if (!res.ok) throw new Error(`VIDEO_DOWNLOAD_FAILED_FETCH: ${res.status} ${res.statusText}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function downloadGenaiFileToBuffer(opts: { uri?: string; name?: string }): Promise<Buffer> {
  const ai = getGenAI();
  const fs = await import("node:fs/promises");

  // 1) Se ho name (files/xxxx), provo ai.files.download -> tmp -> readFile
  if (opts.name) {
    const tmpPath = `/tmp/${newId()}.bin`;
    try {
      await ai.files.download({ file: opts.name, downloadPath: tmpPath });

      // ✅ Cloud Run / ambienti strani: verifica esistenza prima di readFile
      await fs.access(tmpPath);
      const bytes = await fs.readFile(tmpPath);
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore
      }

      if (!bytes || bytes.length === 0) {
        // se è vuoto, fallback fetch
        if (opts.uri) return await fetchVideoByUri(opts.uri);
        throw new Error("VIDEO_DOWNLOAD_FAILED_EMPTY_FILE");
      }

      return Buffer.from(bytes);
    } catch (e: any) {
      // ✅ Se download non crea il file (ENOENT) o fallisce: fallback su fetch(uri)
      try {
        // pulizia best-effort
        await fs.unlink(tmpPath);
      } catch {
        // ignore
      }
      if (opts.uri) return await fetchVideoByUri(opts.uri);
      throw new Error(`VIDEO_DOWNLOAD_FAILED_GENAI: ${e?.message ?? String(e)}`);
    }
  }

  // 2) Se non ho name, provo direttamente fetch(uri)
  if (opts.uri) {
    return await fetchVideoByUri(opts.uri);
  }

  throw new Error("VIDEO_GENERATION_FAILED_NO_FILE_NAME");
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

  if (operation?.error) {
    const msg = operation?.error?.message ?? "VIDEO_GENERATION_FAILED_OPERATION_ERROR";
    throw new Error(msg);
  }

  const generated = operation?.response?.generatedVideos?.[0];
  const video = generated?.video;

  const uri: string | undefined = video?.uri;
  const name: string | undefined = video?.name ?? (uri ? extractFilesNameFromUri(uri) ?? undefined : undefined);

  const bytes =
    typeof video?.videoBytes === "string" && video.videoBytes.length > 0
      ? Buffer.from(video.videoBytes, "base64")
      : await downloadGenaiFileToBuffer({ uri, name });

  if (!bytes || bytes.length === 0) throw new Error("VIDEO_GENERATION_FAILED_EMPTY_BYTES");

  const path = `conversations/${opts.ownerUid}/${opts.conversationId}/videos/${newId()}.mp4`;
  return uploadBytesToStorage({ path, bytes, contentType: "video/mp4" });
}
