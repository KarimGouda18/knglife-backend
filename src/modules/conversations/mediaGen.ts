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
  const m = uri.match(/\/v1beta\/(files\/[^:\s\/\?]+)/);
  return m?.[1] ?? null;
}

async function fetchVideoByUri(uri: string): Promise<Buffer> {
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

  if (opts.name) {
    const tmpPath = `/tmp/${newId()}.bin`;
    try {
      await ai.files.download({ file: opts.name, downloadPath: tmpPath });

      await fs.access(tmpPath);
      const bytes = await fs.readFile(tmpPath);
      try {
        await fs.unlink(tmpPath);
      } catch {}

      if (!bytes || bytes.length === 0) {
        if (opts.uri) return await fetchVideoByUri(opts.uri);
        throw new Error("VIDEO_DOWNLOAD_FAILED_EMPTY_FILE");
      }

      return Buffer.from(bytes);
    } catch (e: any) {
      try {
        await fs.unlink(tmpPath);
      } catch {}
      if (opts.uri) return await fetchVideoByUri(opts.uri);
      throw new Error(`VIDEO_DOWNLOAD_FAILED_GENAI: ${e?.message ?? String(e)}`);
    }
  }

  if (opts.uri) {
    return await fetchVideoByUri(opts.uri);
  }

  throw new Error("VIDEO_GENERATION_FAILED_NO_FILE_NAME");
}

function clampDurationSeconds(s: number) {
  const n = Math.floor(Number(s));
  if (!Number.isFinite(n) || n <= 0) return 8;
  // Veo base: 8s. Extension: +7s fino a 20 volte => max 148s.
  if (n < 4) return 4;
  if (n > 148) return 148;
  return n;
}

function requiredExtensionHops(targetSeconds: number) {
  if (targetSeconds <= 8) return 0;
  return Math.min(20, Math.ceil((targetSeconds - 8) / 7));
}

function continuationPrompt(basePrompt: string, hopIndex: number, totalHops: number) {
  const p = String(basePrompt ?? "").trim();
  const extra = `Continua la stessa scena in modo coerente (estensione ${hopIndex}/${totalHops}), mantenendo personaggi, ambiente, stile e audio coerenti.`;
  return p ? `${p}\n\n${extra}` : extra;
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

  // ✅ durata desiderata (secondi). Se > 8, usa estensioni Veo (+7s per hop, max 20) :contentReference[oaicite:1]{index=1}
  durationSeconds?: number;
}) {
  const ai = getGenAI();

  const safetySettings = getGeminiSafetySettings({
    userBirthDate: opts.user.birthDate,
    userNsfwEnabled: opts.user.nsfwEnabled,
    assistantNsfwEnabled: opts.assistant.nsfwEnabled
  });

  const model = normalizeVeoModelName(env.VEO_VIDEO_MODEL);

  const targetSeconds = opts.durationSeconds ? clampDurationSeconds(opts.durationSeconds) : 8;
  const hops = requiredExtensionHops(targetSeconds);

  // estensione richiede 720p :contentReference[oaicite:2]{index=2}
  const baseResolution = hops > 0 ? "720p" : undefined;

  const hasAvatar = !!opts.assistant.avatar?.downloadUrl;
  const useRef = !!opts.useAssistantAvatar && hasAvatar;

  // 1) Generazione base
  let operation: any;
  if (useRef) {
    const { base64, mimeType } = await fetchAsBase64(opts.assistant.avatar!.downloadUrl);

    operation = await ai.models.generateVideos({
      model,
      prompt: opts.prompt,
      image: { imageBytes: base64, mimeType },
      config: { safetySettings, ...(baseResolution ? { resolution: baseResolution } : {}) }
    });
  } else {
    operation = await ai.models.generateVideos({
      model,
      prompt: opts.prompt,
      config: { safetySettings, ...(baseResolution ? { resolution: baseResolution } : {}) }
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

  // 2) Estensioni (se richieste)
  let currentVideo = operation?.response?.generatedVideos?.[0]?.video;
  if (!currentVideo) throw new Error("VIDEO_GENERATION_FAILED_NO_VIDEO_REF");

  for (let i = 1; i <= hops; i++) {
    let extOp = await ai.models.generateVideos({
      model,
      // L’API estende passando il video precedente come input :contentReference[oaicite:3]{index=3}
      video: currentVideo,
      prompt: continuationPrompt(opts.prompt, i, hops),
      config: { safetySettings, resolution: "720p", numberOfVideos: 1 }
    });

    while (!extOp?.done) {
      await new Promise((r) => setTimeout(r, 10_000));
      extOp = await ai.operations.getVideosOperation({ operation: extOp });
    }

    if (extOp?.error) {
      const msg = extOp?.error?.message ?? "VIDEO_EXTENSION_FAILED_OPERATION_ERROR";
      throw new Error(msg);
    }

    currentVideo = extOp?.response?.generatedVideos?.[0]?.video;
    if (!currentVideo) throw new Error("VIDEO_EXTENSION_FAILED_NO_VIDEO_REF");
    operation = extOp;
  }

  const video = operation?.response?.generatedVideos?.[0]?.video;

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
