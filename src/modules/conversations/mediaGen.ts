// src/modules/conversations/mediaGen.ts
import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { uploadBytesToStorage } from "../../shared/utils/storage.js";
import type { UserProfile } from "../users/userRepo.js";
import type { AssistantDoc } from "../assistants/assistantsRepo.js";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

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

/**
 * Concatena più video MP4 usando FFmpeg.
 * IMPORTANTE: I video devono avere stesso codec/risoluzione per concat funzionare bene.
 */
async function concatenateVideos(videoBuffers: Buffer[]): Promise<Buffer> {
  if (videoBuffers.length === 0) {
    throw new Error("CONCATENATE_VIDEOS_NO_VIDEOS");
  }

  if (videoBuffers.length === 1) {
    // Nessuna concatenazione necessaria
    return videoBuffers[0];
  }

  const tmpDir = `/tmp/video-concat-${newId()}`;
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    // Scrivi tutti i video in file temporanei
    const inputFiles: string[] = [];
    for (let i = 0; i < videoBuffers.length; i++) {
      const inputPath = path.join(tmpDir, `input_${i}.mp4`);
      await fs.writeFile(inputPath, videoBuffers[i]);
      inputFiles.push(inputPath);
    }

    // Crea il file list per FFmpeg concat demuxer
    const listPath = path.join(tmpDir, "list.txt");
    const listContent = inputFiles.map(f => `file '${f}'`).join("\n");
    await fs.writeFile(listPath, listContent);

    // Output path
    const outputPath = path.join(tmpDir, "output.mp4");

    console.log(`🎬 Concatenating ${videoBuffers.length} videos with FFmpeg...`);

    // Esegui FFmpeg
    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c", "copy", // Copy codec (fast, no re-encoding)
        outputPath
      ]);

      let stderr = "";

      ffmpeg.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      ffmpeg.on("close", (code) => {
        if (code !== 0) {
          console.error("FFmpeg stderr:", stderr);
          reject(new Error(`FFMPEG_CONCAT_FAILED: exit code ${code}`));
        } else {
          console.log(`✅ FFmpeg concatenation completed`);
          resolve();
        }
      });

      ffmpeg.on("error", (err) => {
        reject(new Error(`FFMPEG_SPAWN_ERROR: ${err.message}`));
      });
    });

    // Leggi il file output
    const outputBuffer = await fs.readFile(outputPath);

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });

    console.log(`✅ Concatenated video: ${outputBuffer.length} bytes`);
    return outputBuffer;

  } catch (error) {
    // Cleanup in caso di errore
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
    throw error;
  }
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

  console.log(`🎬 Video generation: target=${targetSeconds}s, hops=${hops}`);

  const hasAvatar = !!opts.assistant.avatar?.downloadUrl;
  const useRef = !!opts.useAssistantAvatar && hasAvatar;

  const baseConfig: any = {
    safetySettings,
    numberOfVideos: 1
  };

  // Array per raccogliere tutti i video buffers
  const videoBuffers: Buffer[] = [];

  // 1️⃣ Generazione base (8 secondi)
  console.log(`🎬 Step 1/${hops + 1}: Generating base video (8s)...`);

  let operation: any;

  if (useRef) {
    const { base64, mimeType } = await fetchAsBase64(opts.assistant.avatar!.downloadUrl);

    operation = await ai.models.generateVideos({
      model,
      prompt: opts.prompt,
      image: { imageBytes: base64, mimeType },
      config: baseConfig
    });
  } else {
    operation = await ai.models.generateVideos({
      model,
      prompt: opts.prompt,
      config: baseConfig
    });
  }

  // Poll base video
  while (!operation?.done) {
    await new Promise((r) => setTimeout(r, 10_000));
    operation = await ai.operations.getVideosOperation({ operation });
  }

  if (operation?.error) {
    const msg = operation?.error?.message ?? "VIDEO_GENERATION_FAILED_OPERATION_ERROR";
    throw new Error(msg);
  }

  let currentVideoRef = operation?.response?.generatedVideos?.[0]?.video;
  if (!currentVideoRef) {
    throw new Error("VIDEO_GENERATION_FAILED_NO_VIDEO_REF");
  }

  console.log(`✅ Base video generated`);

  // ✅ SCARICA il video base
  const baseVideoUri = currentVideoRef?.uri;
  const baseVideoName = currentVideoRef?.name ?? (baseVideoUri ? extractFilesNameFromUri(baseVideoUri) ?? undefined : undefined);

  console.log(`🎬 Downloading base video: uri=${baseVideoUri}, name=${baseVideoName}`);

  const baseVideoBytes =
    typeof currentVideoRef?.videoBytes === "string" && currentVideoRef.videoBytes.length > 0
      ? Buffer.from(currentVideoRef.videoBytes, "base64")
      : await downloadGenaiFileToBuffer({ uri: baseVideoUri, name: baseVideoName });

  videoBuffers.push(baseVideoBytes);
  console.log(`✅ Base video downloaded: ${baseVideoBytes.length} bytes`);

  // 2️⃣ Estensioni (se richieste)
  if (hops > 0) {
    console.log(`🎬 Starting ${hops} extension(s)...`);
  }

  for (let i = 1; i <= hops; i++) {
    console.log(`🎬 Step ${i + 1}/${hops + 1}: Extension ${i}/${hops} (+7s)...`);

    const extConfig: any = {
      safetySettings,
      numberOfVideos: 1
    };

    let extOp = await ai.models.generateVideos({
      model,
      video: currentVideoRef, // Riferimento video precedente
      prompt: continuationPrompt(opts.prompt, i, hops),
      config: extConfig
    });

    // Poll estensione
    while (!extOp?.done) {
      await new Promise((r) => setTimeout(r, 10_000));
      extOp = await ai.operations.getVideosOperation({ operation: extOp });
    }

    if (extOp?.error) {
      const msg = extOp?.error?.message ?? `VIDEO_EXTENSION_${i}_FAILED: ${extOp?.error?.message}`;
      throw new Error(msg);
    }

    currentVideoRef = extOp?.response?.generatedVideos?.[0]?.video;
    if (!currentVideoRef) {
      throw new Error(`VIDEO_EXTENSION_${i}_FAILED_NO_VIDEO_REF`);
    }

    console.log(`✅ Extension ${i}/${hops} generated`);

    // ✅ SCARICA OGNI estensione
    const extVideoUri = currentVideoRef?.uri;
    const extVideoName = currentVideoRef?.name ?? (extVideoUri ? extractFilesNameFromUri(extVideoUri) ?? undefined : undefined);

    console.log(`🎬 Downloading extension ${i}: uri=${extVideoUri}, name=${extVideoName}`);

    const extVideoBytes =
      typeof currentVideoRef?.videoBytes === "string" && currentVideoRef.videoBytes.length > 0
        ? Buffer.from(currentVideoRef.videoBytes, "base64")
        : await downloadGenaiFileToBuffer({ uri: extVideoUri, name: extVideoName });

    videoBuffers.push(extVideoBytes);
    console.log(`✅ Extension ${i} downloaded: ${extVideoBytes.length} bytes`);
  }

  console.log(`🎬 All videos downloaded (${videoBuffers.length} clips). Concatenating...`);

  // 3️⃣ Concatena tutti i video
  const finalVideoBytes = await concatenateVideos(videoBuffers);

  console.log(`✅ Final concatenated video: ${finalVideoBytes.length} bytes`);

  // 4️⃣ Upload su Firebase Storage
  const storagePath = `conversations/${opts.ownerUid}/${opts.conversationId}/videos/${newId()}.mp4`;

  console.log(`🎬 Uploading to storage: ${storagePath}`);

  const uploaded = await uploadBytesToStorage({
    path: storagePath,
    bytes: finalVideoBytes,
    contentType: "video/mp4"
  });

  console.log(`✅ Video generation complete! Duration: ~${targetSeconds}s`);

  return uploaded;
}