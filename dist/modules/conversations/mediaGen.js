// src/modules/conversations/mediaGen.ts
import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings } from "../../shared/utils/safety.js";
import { uploadBytesToStorage } from "../../shared/utils/storage.js";
import { promises as fs } from "node:fs";
// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------
function newId() {
    return crypto.randomUUID();
}
/**
 * Normalizes shorthand VEO model aliases to their full API identifiers.
 */
function normalizeVeoModelName(model) {
    if (model === "veo-3.1")
        return "veo-3.1-generate-preview";
    return model;
}
/**
 * Fetches a remote URL and returns its content as a base64 string.
 */
async function fetchAsBase64(url) {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`FETCH_REFERENCE_IMAGE_FAILED: ${res.status} ${res.statusText}`);
    const mimeType = res.headers.get("content-type") || "image/jpeg";
    const ab = await res.arrayBuffer();
    return { base64: Buffer.from(ab).toString("base64"), mimeType };
}
function guessImageExt(mime) {
    if (mime.includes("jpeg") || mime.includes("jpg"))
        return "jpg";
    if (mime.includes("webp"))
        return "webp";
    return "png";
}
/**
 * Extracts the `files/xxx` name from a Gemini Files API URI, if present.
 */
function extractFilesNameFromUri(uri) {
    const m = uri.match(/\/v1beta\/(files\/[^:\s\/\?]+)/);
    return m?.[1] ?? null;
}
/**
 * Downloads a video by URI using the Gemini API key in the Authorization header.
 */
async function fetchVideoByUri(uri) {
    const res = await fetch(uri, {
        headers: { "x-goog-api-key": env.GEMINI_API_KEY }
    });
    if (!res.ok)
        throw new Error(`VIDEO_DOWNLOAD_FAILED_FETCH: ${res.status} ${res.statusText}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
}
/**
 * Downloads a generated video from the GenAI Files API to an in-memory buffer.
 * Tries the named-file download path first and falls back to direct URI fetch.
 */
async function downloadGenaiFileToBuffer(opts) {
    const ai = getGenAI();
    if (opts.name) {
        const tmpPath = `/tmp/${newId()}.bin`;
        try {
            await ai.files.download({ file: opts.name, downloadPath: tmpPath });
            await fs.access(tmpPath);
            const bytes = await fs.readFile(tmpPath);
            try {
                await fs.unlink(tmpPath);
            }
            catch { /* best-effort cleanup */ }
            if (!bytes || bytes.length === 0) {
                if (opts.uri)
                    return await fetchVideoByUri(opts.uri);
                throw new Error("VIDEO_DOWNLOAD_FAILED_EMPTY_FILE");
            }
            return Buffer.from(bytes);
        }
        catch (e) {
            try {
                await fs.unlink(tmpPath);
            }
            catch { /* best-effort cleanup */ }
            if (opts.uri)
                return await fetchVideoByUri(opts.uri);
            throw new Error(`VIDEO_DOWNLOAD_FAILED_GENAI: ${e?.message ?? String(e)}`);
        }
    }
    if (opts.uri)
        return await fetchVideoByUri(opts.uri);
    throw new Error("VIDEO_GENERATION_FAILED_NO_FILE_NAME");
}
/**
 * Polls a VEO operation until it completes, then extracts the video reference.
 */
async function pollVideoOperation(ai, operation) {
    let op = operation;
    while (!op?.done) {
        await new Promise((r) => setTimeout(r, 10_000));
        op = await ai.operations.getVideosOperation({ operation: op });
    }
    if (op?.error) {
        throw new Error(op.error?.message ?? "VIDEO_OPERATION_FAILED");
    }
    const videoRef = op?.response?.generatedVideos?.[0]?.video;
    if (!videoRef)
        throw new Error("VIDEO_GENERATION_FAILED_NO_VIDEO_REF");
    return videoRef;
}
/**
 * Downloads a video reference (from a completed VEO operation) to a Buffer.
 */
async function downloadVideoRef(videoRef) {
    if (typeof videoRef?.videoBytes === "string" && videoRef.videoBytes.length > 0) {
        return Buffer.from(videoRef.videoBytes, "base64");
    }
    const uri = videoRef?.uri;
    const name = videoRef?.name ?? (uri ? extractFilesNameFromUri(uri) ?? undefined : undefined);
    return downloadGenaiFileToBuffer({ uri, name });
}
// ---------------------------------------------------------------------------
// Image generation (unchanged logic, cleaned up)
// ---------------------------------------------------------------------------
export async function generateConversationImage(opts) {
    const ai = getGenAI();
    const safetySettings = getGeminiSafetySettings({
        userBirthDate: opts.user.birthDate,
        userNsfwEnabled: opts.user.nsfwEnabled,
        assistantNsfwEnabled: opts.assistant.nsfwEnabled
    });
    const hasAvatar = !!opts.assistant.avatar?.downloadUrl;
    const useRef = !!opts.useAssistantAvatar && hasAvatar;
    let resp;
    if (useRef) {
        const { base64, mimeType } = await fetchAsBase64(opts.assistant.avatar.downloadUrl);
        resp = await ai.models.generateContent({
            model: env.GEMINI_IMAGE_MODEL,
            contents: [{ role: "user", parts: [{ text: opts.prompt }, { inlineData: { data: base64, mimeType } }] }],
            config: { responseModalities: ["IMAGE"], safetySettings }
        });
    }
    else {
        resp = await ai.models.generateContent({
            model: env.GEMINI_IMAGE_MODEL,
            contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
            config: { responseModalities: ["IMAGE"], safetySettings }
        });
    }
    const bytesBase64 = resp?.generatedImages?.[0]?.image?.imageBytes ??
        resp?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
    const mimeType = resp?.generatedImages?.[0]?.image?.mimeType ??
        resp?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.mimeType ??
        "image/png";
    if (!bytesBase64)
        throw new Error("IMAGE_GENERATION_FAILED_NO_BYTES");
    const bytes = Buffer.from(bytesBase64, "base64");
    const ext = guessImageExt(mimeType);
    const storagePath = `conversations/${opts.ownerUid}/${opts.conversationId}/images/${newId()}.${ext}`;
    return uploadBytesToStorage({ path: storagePath, bytes, contentType: mimeType });
}
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
export async function generateConversationVideo(opts) {
    const ai = getGenAI();
    const model = normalizeVeoModelName(env.VEO_VIDEO_MODEL);
    const safetySettings = getGeminiSafetySettings({
        userBirthDate: opts.user.birthDate,
        userNsfwEnabled: opts.user.nsfwEnabled,
        assistantNsfwEnabled: opts.assistant.nsfwEnabled
    });
    const config = { safetySettings, numberOfVideos: 1 };
    const hasAvatar = !!opts.assistant.avatar?.downloadUrl;
    const isExtension = !!opts.geminiVideoRef?.uri || !!opts.geminiVideoRef?.name;
    let operation;
    if (isExtension) {
        // Extend the existing clip. VEO returns a new video that is the full
        // extended version — the previous clip + the new content. No concatenation needed.
        console.log("Video generation: extending existing clip");
        operation = await ai.models.generateVideos({
            model,
            prompt: opts.prompt,
            video: opts.geminiVideoRef,
            config
        });
    }
    else if (opts.useAssistantAvatar && hasAvatar) {
        // New video with avatar as reference image
        console.log("Video generation: new clip with avatar reference");
        const { base64, mimeType } = await fetchAsBase64(opts.assistant.avatar.downloadUrl);
        operation = await ai.models.generateVideos({
            model,
            prompt: opts.prompt,
            image: { imageBytes: base64, mimeType },
            config
        });
    }
    else {
        // New video from prompt only
        console.log("Video generation: new clip from prompt");
        operation = await ai.models.generateVideos({ model, prompt: opts.prompt, config });
    }
    const videoRef = await pollVideoOperation(ai, operation);
    const bytes = await downloadVideoRef(videoRef);
    const storagePath = `conversations/${opts.ownerUid}/${opts.conversationId}/videos/${newId()}.mp4`;
    const uploadedFile = await uploadBytesToStorage({ path: storagePath, bytes, contentType: "video/mp4" });
    // Extract a serialisable reference for the next extension call
    const outRef = {};
    if (videoRef?.uri)
        outRef.uri = videoRef.uri;
    if (videoRef?.name)
        outRef.name = videoRef.name;
    console.log(`Video generation: done (${bytes.length} bytes), ref:`, outRef);
    return { uploadedFile, geminiVideoRef: outRef };
}
