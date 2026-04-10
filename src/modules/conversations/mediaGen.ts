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

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function newId(): string {
  return crypto.randomUUID();
}

/**
 * Normalizes shorthand VEO model aliases to their full API identifiers.
 */
function normalizeVeoModelName(model: string): string {
  if (model === "veo-3.1") return "veo-3.1-generate-preview";
  return model;
}

/**
 * Fetches a remote URL and returns its content as a base64 string.
 */
async function fetchAsBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FETCH_REFERENCE_IMAGE_FAILED: ${res.status} ${res.statusText}`);
  const mimeType = res.headers.get("content-type") || "image/jpeg";
  const ab = await res.arrayBuffer();
  return { base64: Buffer.from(ab).toString("base64"), mimeType };
}

function guessImageExt(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}

/**
 * Extracts the `files/xxx` name from a Gemini Files API URI, if present.
 */
function extractFilesNameFromUri(uri: string): string | null {
  const m = uri.match(/\/v1beta\/(files\/[^:\s\/\?]+)/);
  return m?.[1] ?? null;
}

/**
 * Downloads a video by URI using the Gemini API key in the Authorization header.
 */
async function fetchVideoByUri(uri: string): Promise<Buffer> {
  const res = await fetch(uri, {
    headers: { "x-goog-api-key": env.GEMINI_API_KEY }
  });
  if (!res.ok) throw new Error(`VIDEO_DOWNLOAD_FAILED_FETCH: ${res.status} ${res.statusText}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Downloads a generated video from the GenAI Files API to an in-memory buffer.
 * Tries the named-file download path first and falls back to direct URI fetch.
 */
async function downloadGenaiFileToBuffer(opts: { uri?: string; name?: string }): Promise<Buffer> {
  const ai = getGenAI();

  if (opts.name) {
    const tmpPath = `/tmp/${newId()}.bin`;
    try {
      await ai.files.download({ file: opts.name, downloadPath: tmpPath });
      await fs.access(tmpPath);
      const bytes = await fs.readFile(tmpPath);
      try { await fs.unlink(tmpPath); } catch { /* best-effort cleanup */ }

      if (!bytes || bytes.length === 0) {
        if (opts.uri) return await fetchVideoByUri(opts.uri);
        throw new Error("VIDEO_DOWNLOAD_FAILED_EMPTY_FILE");
      }
      return Buffer.from(bytes);
    } catch (e: any) {
      try { await fs.unlink(tmpPath); } catch { /* best-effort cleanup */ }
      if (opts.uri) return await fetchVideoByUri(opts.uri);
      throw new Error(`VIDEO_DOWNLOAD_FAILED_GENAI: ${e?.message ?? String(e)}`);
    }
  }

  if (opts.uri) return await fetchVideoByUri(opts.uri);
  throw new Error("VIDEO_GENERATION_FAILED_NO_FILE_NAME");
}

/**
 * Concatenates multiple MP4 buffers into a single MP4 using FFmpeg's concat demuxer.
 * Input clips must share the same codec and resolution for lossless stream-copy to work.
 */
async function concatenateVideos(videoBuffers: Buffer[]): Promise<Buffer> {
  if (videoBuffers.length === 0) throw new Error("CONCATENATE_VIDEOS_NO_VIDEOS");
  if (videoBuffers.length === 1) return videoBuffers[0];

  const tmpDir = `/tmp/video-concat-${newId()}`;
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const inputFiles: string[] = [];
    for (let i = 0; i < videoBuffers.length; i++) {
      const inputPath = path.join(tmpDir, `input_${i}.mp4`);
      await fs.writeFile(inputPath, videoBuffers[i]);
      inputFiles.push(inputPath);
    }

    const listPath = path.join(tmpDir, "list.txt");
    await fs.writeFile(listPath, inputFiles.map(f => `file '${f}'`).join("\n"));

    const outputPath = path.join(tmpDir, "output.mp4");

    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-f", "concat", "-safe", "0",
        "-i", listPath,
        "-c", "copy",
        outputPath
      ]);
      let stderr = "";
      ffmpeg.stderr.on("data", (d) => { stderr += d.toString(); });
      ffmpeg.on("close", (code) => {
        if (code !== 0) reject(new Error(`FFMPEG_CONCAT_FAILED: exit code ${code}\n${stderr}`));
        else resolve();
      });
      ffmpeg.on("error", (err) => reject(new Error(`FFMPEG_SPAWN_ERROR: ${err.message}`)));
    });

    const output = await fs.readFile(outputPath);
    await fs.rm(tmpDir, { recursive: true, force: true });
    return output;
  } catch (error) {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw error;
  }
}

/**
 * Polls a VEO operation until it completes, then extracts the video reference.
 */
async function pollVideoOperation(ai: any, operation: any): Promise<any> {
  let op = operation;
  while (!op?.done) {
    await new Promise((r) => setTimeout(r, 10_000));
    op = await ai.operations.getVideosOperation({ operation: op });
  }
  if (op?.error) {
    throw new Error(op.error?.message ?? "VIDEO_OPERATION_FAILED");
  }
  const videoRef = op?.response?.generatedVideos?.[0]?.video;
  if (!videoRef) throw new Error("VIDEO_GENERATION_FAILED_NO_VIDEO_REF");
  return videoRef;
}

/**
 * Downloads a video reference (from a completed VEO operation) to a Buffer.
 */
async function downloadVideoRef(videoRef: any): Promise<Buffer> {
  if (typeof videoRef?.videoBytes === "string" && videoRef.videoBytes.length > 0) {
    return Buffer.from(videoRef.videoBytes, "base64");
  }
  const uri: string | undefined = videoRef?.uri;
  const name: string | undefined =
    videoRef?.name ?? (uri ? extractFilesNameFromUri(uri) ?? undefined : undefined);
  return downloadGenaiFileToBuffer({ uri, name });
}

// ---------------------------------------------------------------------------
// Common option types
// ---------------------------------------------------------------------------

type MediaUserOpts = Pick<UserProfile, "birthDate" | "nsfwEnabled">;
type MediaAssistantOpts = Pick<AssistantDoc, "nsfwEnabled" | "avatar">;

// ---------------------------------------------------------------------------
// Image generation (unchanged logic, cleaned up)
// ---------------------------------------------------------------------------

export async function generateConversationImage(opts: {
  ownerUid: string;
  conversationId: string;
  prompt: string;
  user: MediaUserOpts;
  assistant: MediaAssistantOpts;
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
      contents: [{ role: "user", parts: [{ text: opts.prompt }, { inlineData: { data: base64, mimeType } }] }],
      config: { responseModalities: ["IMAGE"], safetySettings } as any
    });
  } else {
    resp = await ai.models.generateContent({
      model: env.GEMINI_IMAGE_MODEL,
      contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
      config: { responseModalities: ["IMAGE"], safetySettings } as any
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
  const storagePath = `conversations/${opts.ownerUid}/${opts.conversationId}/images/${newId()}.${ext}`;
  return uploadBytesToStorage({ path: storagePath, bytes, contentType: mimeType });
}

// ---------------------------------------------------------------------------
// Video generation — single-scene mode
// ---------------------------------------------------------------------------

/**
 * Generates a single 8-second video clip from one prompt.
 * Uses the avatar image as a reference frame when `useAssistantAvatar` is set.
 */
async function generateSingleSceneVideo(opts: {
  ownerUid: string;
  conversationId: string;
  prompt: string;
  user: MediaUserOpts;
  assistant: MediaAssistantOpts;
  useAssistantAvatar?: boolean;
}) {
  const ai = getGenAI();
  const model = normalizeVeoModelName(env.VEO_VIDEO_MODEL);
  const safetySettings = getGeminiSafetySettings({
    userBirthDate: opts.user.birthDate,
    userNsfwEnabled: opts.user.nsfwEnabled,
    assistantNsfwEnabled: opts.assistant.nsfwEnabled
  });

  const config: any = { safetySettings, numberOfVideos: 1 };
  const hasAvatar = !!opts.assistant.avatar?.downloadUrl;
  const useRef = !!opts.useAssistantAvatar && hasAvatar;

  let operation: any;
  if (useRef) {
    const { base64, mimeType } = await fetchAsBase64(opts.assistant.avatar!.downloadUrl);
    operation = await ai.models.generateVideos({ model, prompt: opts.prompt, image: { imageBytes: base64, mimeType }, config });
  } else {
    operation = await ai.models.generateVideos({ model, prompt: opts.prompt, config });
  }

  const videoRef = await pollVideoOperation(ai, operation);
  const bytes = await downloadVideoRef(videoRef);

  const storagePath = `conversations/${opts.ownerUid}/${opts.conversationId}/videos/${newId()}.mp4`;
  return uploadBytesToStorage({ path: storagePath, bytes, contentType: "video/mp4" });
}

// ---------------------------------------------------------------------------
// Video generation — multi-scene mode
// ---------------------------------------------------------------------------

/**
 * Generates a multi-scene video by chaining VEO extension calls.
 *
 * Each scene gets its own explicitly authored prompt (mirroring Google Flow's approach):
 * - Scene 0 is generated from scratch (with optional avatar reference image).
 * - Scene N (N > 0) is generated using the previous clip as the reference video plus
 *   the new scene prompt, giving VEO world/character/camera continuity while allowing
 *   a new narrative direction for each scene.
 *
 * Intermediate clips are stored individually for auditability. The final concatenated
 * video is stored at `videos/{sessionId}/final.mp4`.
 */
async function generateMultiSceneVideo(opts: {
  ownerUid: string;
  conversationId: string;
  scenes: string[];           // one prompt per scene, min 2, max 8
  user: MediaUserOpts;
  assistant: MediaAssistantOpts;
  useAssistantAvatar?: boolean;
}) {
  const ai = getGenAI();
  const model = normalizeVeoModelName(env.VEO_VIDEO_MODEL);
  const safetySettings = getGeminiSafetySettings({
    userBirthDate: opts.user.birthDate,
    userNsfwEnabled: opts.user.nsfwEnabled,
    assistantNsfwEnabled: opts.assistant.nsfwEnabled
  });

  const config: any = { safetySettings, numberOfVideos: 1 };
  const sessionId = newId();
  const videoBuffers: Buffer[] = [];

  const hasAvatar = !!opts.assistant.avatar?.downloadUrl;
  const useRef = !!opts.useAssistantAvatar && hasAvatar;

  let previousVideoRef: any = null;

  for (let i = 0; i < opts.scenes.length; i++) {
    const scenePrompt = opts.scenes[i];
    console.log(`Video multi-scene: generating scene ${i + 1}/${opts.scenes.length}`);

    let operation: any;

    if (i === 0) {
      // First scene — no previous clip reference
      if (useRef) {
        const { base64, mimeType } = await fetchAsBase64(opts.assistant.avatar!.downloadUrl);
        operation = await ai.models.generateVideos({
          model, prompt: scenePrompt,
          image: { imageBytes: base64, mimeType },
          config
        });
      } else {
        operation = await ai.models.generateVideos({ model, prompt: scenePrompt, config });
      }
    } else {
      // Subsequent scenes — use the previous clip as reference to drive continuity.
      // Cast to `any` because the SDK's TypeScript types do not yet expose the
      // `video` extension parameter, even though the API supports it.
      operation = await (ai.models.generateVideos as any)({
        model,
        prompt: scenePrompt,
        video: previousVideoRef,
        config
      });
    }

    const videoRef = await pollVideoOperation(ai, operation);
    const bytes = await downloadVideoRef(videoRef);
    videoBuffers.push(bytes);

    // Store the intermediate scene clip
    const scenePath = `conversations/${opts.ownerUid}/${opts.conversationId}/videos/${sessionId}/scene_${i}.mp4`;
    await uploadBytesToStorage({ path: scenePath, bytes, contentType: "video/mp4" });

    // Keep the raw video reference for the next extension call
    previousVideoRef = videoRef;
    console.log(`Video multi-scene: scene ${i + 1} done (${bytes.length} bytes)`);
  }

  // Concatenate all scene clips and store the final video
  const finalBytes = await concatenateVideos(videoBuffers);
  const finalPath = `conversations/${opts.ownerUid}/${opts.conversationId}/videos/${sessionId}/final.mp4`;
  return uploadBytesToStorage({ path: finalPath, bytes: finalBytes, contentType: "video/mp4" });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a conversation video in one of two modes:
 *
 * - `single`: one VEO call → one 8-second clip.
 * - `multi`:  one VEO call per scene, chained via the extension API, then concatenated.
 *   Each scene must supply its own prompt; VEO uses the previous clip for visual continuity.
 */
export async function generateConversationVideo(
  opts:
    | {
        mode: "single";
        ownerUid: string;
        conversationId: string;
        prompt: string;
        user: MediaUserOpts;
        assistant: MediaAssistantOpts;
        useAssistantAvatar?: boolean;
      }
    | {
        mode: "multi";
        ownerUid: string;
        conversationId: string;
        scenes: string[];
        user: MediaUserOpts;
        assistant: MediaAssistantOpts;
        useAssistantAvatar?: boolean;
      }
) {
  if (opts.mode === "single") {
    return generateSingleSceneVideo(opts);
  }
  return generateMultiSceneVideo(opts);
}
