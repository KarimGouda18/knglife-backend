// src/modules/conversations/mediaGen.ts
import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { uploadBytesToStorage } from "../../shared/utils/storage.js";
import type { UserProfile } from "../users/userRepo.js";
import type { AssistantDoc } from "../assistants/assistantsRepo.js";
import { promises as fs } from "node:fs";

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
 * Polls a VEO operation until it completes, then extracts the video reference.
 *
 * The Gemini Developer API may return the response in a different shape than
 * what the SDK TypeScript types describe.  We probe several known paths so that
 * any format variation is handled gracefully, and we log the raw response to
 * Cloud Run logs to help diagnose unexpected shapes.
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

  // Log the full response so we can inspect the real shape in Cloud Run logs.
  try {
    console.log("[VEO] operation done, response:", JSON.stringify(op?.response ?? op));
  } catch { /* non-serialisable — ignore */ }

  // Try every known response shape:
  //   1. SDK canonical: response.generatedVideos[0].video
  //   2. Gemini Developer API: response.generateVideoResponse.generatedSamples[0].video
  //   3. Flat array on response itself: response.videos[0]
  //   4. Direct on operation root (some SDK versions flatten it): op.generatedVideos[0].video
  const r: any = op?.response;
  const videoRef: any =
    r?.generatedVideos?.[0]?.video ??
    r?.generateVideoResponse?.generatedSamples?.[0]?.video ??
    r?.generateVideoResponse?.generatedSamples?.[0] ??
    r?.videos?.[0]?.video ??
    r?.videos?.[0] ??
    op?.generatedVideos?.[0]?.video;

  if (!videoRef) {
    const filtered: number = r?.raiMediaFilteredCount ?? 0;
    if (filtered > 0) {
      const reasons: string = (r?.raiMediaFilteredReasons ?? []).join(", ") || "content policy";
      throw new Error(`VIDEO_FILTERED_BY_RAI: ${reasons}`);
    }
    // Include a snapshot of the response to surface in Sentry / logs.
    const snapshot = (() => { try { return JSON.stringify(r ?? op); } catch { return "(non-serialisable)"; } })();
    throw new Error(`VIDEO_GENERATION_FAILED_NO_VIDEO_REF — response: ${snapshot}`);
  }

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
// Video generation — generate or extend
// ---------------------------------------------------------------------------

/**
 * A minimal reference to a VEO-generated video that can be passed back
 * to subsequent extension calls. Clients should store this and include it
 * in the next request to extend the clip.
 *
 * Mirrors the SDK's `Video` type: { uri?, videoBytes?, mimeType? }.
 * The `mimeType` field is required by VEO to identify the video format
 * during extension calls.
 */
export type GeminiVideoRef = { uri?: string; mimeType?: string };

/**
 * Generates a new video clip or extends an existing one using VEO's native
 * extension API.
 *
 * **New video**: omit `geminiVideoRef`. VEO generates an 8-second clip from
 * the prompt (+ optional avatar reference image).
 *
 * **Extension**: pass `geminiVideoRef` from the previous response. VEO uses
 * the previous clip for visual/world/character continuity and generates a new
 * extended clip (the returned video is the complete extended version — no
 * concatenation required). The process can be repeated up to ~240 seconds.
 *
 * Returns both the uploaded file info and the `geminiVideoRef` to use for the
 * next extension call.
 */
export async function generateConversationVideo(opts: {
  ownerUid: string;
  conversationId: string;
  prompt: string;
  user: MediaUserOpts;
  assistant: MediaAssistantOpts;
  useAssistantAvatar?: boolean;
  /** If provided, extends the referenced clip instead of generating a new one. */
  geminiVideoRef?: GeminiVideoRef;
}): Promise<{ uploadedFile: Awaited<ReturnType<typeof uploadBytesToStorage>>; geminiVideoRef: GeminiVideoRef }> {
  const ai = getGenAI();
  const model = normalizeVeoModelName(env.VEO_VIDEO_MODEL);
  const safetySettings = getGeminiSafetySettings({
    userBirthDate: opts.user.birthDate,
    userNsfwEnabled: opts.user.nsfwEnabled,
    assistantNsfwEnabled: opts.assistant.nsfwEnabled
  });

  // safetySettings is NOT part of GenerateVideosConfig — VEO does not accept it.
  //
  // Resolution MUST be "720p" for ALL calls (initial generation AND extension).
  // VEO extension only works when the source clip is 720p; if the original was
  // generated at a different resolution the API falls back to reference-based
  // generation (new independent clip) instead of appending to the existing one.
  const config: any = { numberOfVideos: 1, resolution: "720p", aspectRatio: "16:9" };
  const hasAvatar = !!opts.assistant.avatar?.downloadUrl;
  const isExtension = !!opts.geminiVideoRef?.uri;

  let operation: any;

  if (isExtension) {
    // Extend the existing clip. VEO appends ~7 s of new content to the source
    // clip and returns the full combined video (original + extension).
    // Requirements: source must be a Veo-generated 720p clip ≤ 30 s, generated
    // within the last 48 h.  Pass only uri + mimeType — no extra fields.
    console.log("Video generation: extending existing clip, ref uri:", opts.geminiVideoRef!.uri?.slice(0, 80));
    operation = await (ai.models.generateVideos as any)({
      model,
      prompt: opts.prompt,
      video: { uri: opts.geminiVideoRef!.uri, mimeType: opts.geminiVideoRef!.mimeType ?? "video/mp4" },
      config
    });
  } else if (opts.useAssistantAvatar && hasAvatar) {
    // New video with avatar as reference image
    console.log("Video generation: new clip with avatar reference");
    const { base64, mimeType } = await fetchAsBase64(opts.assistant.avatar!.downloadUrl);
    operation = await (ai.models.generateVideos as any)({
      model,
      prompt: opts.prompt,
      image: { imageBytes: base64, mimeType },
      config
    });
  } else {
    // New video from prompt only
    console.log("Video generation: new clip from prompt");
    operation = await (ai.models.generateVideos as any)({ model, prompt: opts.prompt, config });
  }

  const videoRef = await pollVideoOperation(ai, operation);
  const bytes = await downloadVideoRef(videoRef);

  const storagePath = `conversations/${opts.ownerUid}/${opts.conversationId}/videos/${newId()}.mp4`;
  const uploadedFile = await uploadBytesToStorage({ path: storagePath, bytes, contentType: "video/mp4" });

  // Extract a serialisable reference for the next extension call.
  // Matches the SDK's Video type: { uri?, videoBytes?, mimeType? }.
  // mimeType is captured so VEO can recognise the format on subsequent extension calls.
  const outRef: GeminiVideoRef = {};
  if (videoRef?.uri) outRef.uri = videoRef.uri;
  outRef.mimeType = videoRef?.mimeType ?? "video/mp4";

  console.log(`Video generation: done (${bytes.length} bytes), ref:`, outRef);
  return { uploadedFile, geminiVideoRef: outRef };
}
