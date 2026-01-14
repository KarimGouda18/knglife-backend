// src/live/wsServer.ts
import http from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { URL } from "node:url";
import { env } from "../config/env.js";
import { getAuth, getFirestore } from "../config/firebase.js";
import { getGenAI } from "../config/genai.js";
import { getGeminiSafetySettings } from "../shared/utils/safety.js";
import { getOrCreateUserProfile } from "../modules/users/userRepo.js";
import { getAssistant } from "../modules/assistants/assistantsRepo.js";
import { buildAssistantLiveSystemPrompt, buildInterviewLiveSystemPrompt } from "./prompts.js";
import { addInterviewMessage, createInterview } from "../modules/interview/interviewRepo.js";

/**
 * Protocollo WS (client -> server):
 * - { type: "input_audio", dataBase64: string, mimeType?: string }  // default: audio/pcm;rate=16000
 * - { type: "input_text", text: string }                           // opzionale (debug)
 * - { type: "end_turn" }                                           // opzionale
 * - { type: "close" }
 *
 * Server -> client (normalizzato, più "raw"):
 * - { type: "ready", session: {...} }
 * - { type: "output_audio", dataBase64: string, mimeType: string }
 * - { type: "output_transcription", text: string }
 * - { type: "input_transcription", text: string }
 * - { type: "raw", message: any }                                  // sempre utile per debug
 * - { type: "error", error: string }
 */

type ClientMsg =
  | { type: "input_audio"; dataBase64: string; mimeType?: string }
  | { type: "input_text"; text: string }
  | { type: "end_turn" }
  | { type: "close" };

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function getBearerFromReq(req: http.IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (!h) return null;
  const v = Array.isArray(h) ? h[0] : h;
  const m = v.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

async function verifyIdTokenFromReq(req: http.IncomingMessage): Promise<{ uid: string; email: string | null } | null> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const tokenFromQuery = url.searchParams.get("idToken");
  const token = getBearerFromReq(req) ?? tokenFromQuery;

  if (!token) return null;

  const decoded = await getAuth().verifyIdToken(token);
  return { uid: decoded.uid, email: decoded.email ?? null };
}

function wsSend(ws: WebSocket, obj: any) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function normalizePrivateWsError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg || "Unknown error";
}

function pickVoiceName(assistant: any): string {
  // Se in futuro aggiungi assistant.voiceName nel doc, usalo qui.
  // Per ora fallback.
  return assistant?.voiceName || "Kore";
}

/**
 * Estrae audio/transcription dai messaggi Live.
 * La struttura può evolvere: per sicurezza inoltriamo sempre anche "raw".
 */
function extractSignals(m: any): {
  outputAudio?: { dataBase64: string; mimeType: string };
  outputTranscription?: string;
  inputTranscription?: string;
} {
  const outTr =
    m?.serverContent?.outputTranscription?.text ??
    m?.outputAudioTranscription?.text ??
    m?.outputTranscription?.text ??
    null;

  const inTr =
    m?.serverContent?.inputTranscription?.text ??
    m?.inputAudioTranscription?.text ??
    m?.inputTranscription?.text ??
    null;

  let audioData: string | null = null;
  let audioMime: string | null = null;

  if (typeof m?.data === "string" && typeof m?.mimeType === "string") {
    audioData = m.data;
    audioMime = m.mimeType;
  }

  const parts = m?.serverContent?.modelTurn?.parts ?? m?.modelTurn?.parts ?? null;
  if (!audioData && Array.isArray(parts)) {
    for (const p of parts) {
      const inline = p?.inlineData ?? p?.inline_data ?? null;
      if (inline && typeof inline.data === "string") {
        audioData = inline.data;
        audioMime = inline.mimeType || inline.mime_type || "audio/pcm;rate=24000";
        break;
      }
    }
  }

  const result: any = {};
  if (audioData) result.outputAudio = { dataBase64: audioData, mimeType: audioMime ?? "audio/pcm;rate=24000" };
  if (typeof outTr === "string" && outTr.trim()) result.outputTranscription = outTr.trim();
  if (typeof inTr === "string" && inTr.trim()) result.inputTranscription = inTr.trim();
  return result;
}

function shouldPersistTranscriptChunk(text: string) {
  const t = text.trim();
  if (!t) return false;
  // evita spam: chunk troppo corto spesso è parziale
  if (t.length < 2) return false;
  return true;
}

export function attachLiveWebSocketServer(server: http.Server) {
  const wss = new WebSocketServer({ server });

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (!pathname.startsWith("/api/live/")) {
      ws.close(1008, "Unsupported path");
      return;
    }

    try {
      const authUser = await verifyIdTokenFromReq(req);
      if (!authUser) {
        wsSend(ws, { type: "error", error: "MISSING_ID_TOKEN (use Authorization Bearer or ?idToken=...)" });
        ws.close(1008, "Unauthorized");
        return;
      }

      const db = getFirestore();
      const userProfile = await getOrCreateUserProfile(db, authUser.uid, authUser.email);

      const ai = getGenAI();

      const isInterview = pathname === "/api/live/interview";
      let systemPrompt = "";
      let assistant: any = null;
      let voiceName = "Kore";

      // ✅ Per la live interview creiamo un InterviewDoc e salviamo trascrizioni lì
      let interviewId: string | null = null;
      let interviewNsfwEnabled = false;

      // dedupe semplice per evitare duplicati identici
      let lastSavedUserTr = "";
      let lastSavedAssistantTr = "";

      if (isInterview) {
        // snapshot NSFW dal profilo (come la text interview)
        const interview = await createInterview(db, authUser.uid, userProfile.nsfwEnabled);
        interviewId = interview.id;
        interviewNsfwEnabled = interview.nsfwEnabled;

        const safetyForAllowExplicit = getGeminiSafetySettings({
          userBirthDate: userProfile.birthDate,
          userNsfwEnabled: interviewNsfwEnabled,
          assistantNsfwEnabled: interviewNsfwEnabled
        });

        const allowExplicit = safetyForAllowExplicit[0]?.threshold === "BLOCK_NONE";

        systemPrompt = buildInterviewLiveSystemPrompt({
          user: {
            name: userProfile.name,
            surname: userProfile.surname,
            birthDate: userProfile.birthDate,
            age: userProfile.age,
            gender: userProfile.gender,
            visualDisabilityLevel: userProfile.visualDisabilityLevel,
            bio: userProfile.bio,
            nsfwEnabled: userProfile.nsfwEnabled
          },
          interviewNsfwEnabled,
          allowExplicit
        });
      } else {
        const m = pathname.match(/^\/api\/live\/assistants\/([^/]+)$/);
        const assistantId = m?.[1];
        if (!assistantId) {
          wsSend(ws, { type: "error", error: "MISSING_ASSISTANT_ID" });
          ws.close(1008, "Bad request");
          return;
        }

        assistant = await getAssistant(db, assistantId);
        if (!assistant || assistant.ownerUid !== authUser.uid) {
          wsSend(ws, { type: "error", error: "ASSISTANT_NOT_FOUND" });
          ws.close(1008, "Not found");
          return;
        }

        voiceName = pickVoiceName(assistant);

        systemPrompt = buildAssistantLiveSystemPrompt({
          user: {
            name: userProfile.name,
            surname: userProfile.surname,
            birthDate: userProfile.birthDate,
            age: userProfile.age,
            gender: userProfile.gender,
            visualDisabilityLevel: userProfile.visualDisabilityLevel,
            bio: userProfile.bio,
            nsfwEnabled: userProfile.nsfwEnabled
          },
          assistant: {
            name: assistant.name,
            surname: assistant.surname,
            age: assistant.age,
            gender: assistant.gender,
            relationship: assistant.relationship,
            bio: assistant.bio,
            nsfwEnabled: assistant.nsfwEnabled,
            avatarSpec: assistant.avatarSpec
          }
        });
      }

      const safetySettings = getGeminiSafetySettings({
        userBirthDate: userProfile.birthDate,
        userNsfwEnabled: isInterview ? interviewNsfwEnabled : userProfile.nsfwEnabled,
        assistantNsfwEnabled: isInterview ? interviewNsfwEnabled : (assistant?.nsfwEnabled ?? false)
      });

      const session = await ai.live.connect({
        model: env.GEMINI_REALTIME_MODEL,
        config: {
          responseModalities: ["AUDIO"],
          systemInstruction: systemPrompt,
          safetySettings,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName }
            }
          }
          // tools: [{ googleSearch: {} }],
        },
        callbacks: {
          onopen: async () => {
            wsSend(ws, {
              type: "ready",
              session: {
                mode: isInterview ? "interview" : "assistant",
                voiceName,
                model: env.GEMINI_REALTIME_MODEL,
                // ✅ fondamentale: il frontend usa questo per chiamare /finish
                interviewId: interviewId ?? undefined
              }
            });

            // ✅ Per la Live interview facciamo partire subito la prima domanda (come /start nella text interview)
            if (isInterview) {
              try {
                await session.sendClientContent({
                  turns: [{ role: "user", parts: [{ text: "Inizia l'intervista con la prima domanda." }] }],
                  turnComplete: true
                });
              } catch {}
            }
          },
          onmessage: async (message: any) => {
            wsSend(ws, { type: "raw", message });

            const sig = extractSignals(message);

            if (sig.inputTranscription) {
              wsSend(ws, { type: "input_transcription", text: sig.inputTranscription });

              if (isInterview && interviewId && shouldPersistTranscriptChunk(sig.inputTranscription)) {
                const t = sig.inputTranscription.trim();
                if (t && t !== lastSavedUserTr) {
                  lastSavedUserTr = t;
                  try {
                    await addInterviewMessage(db, authUser.uid, interviewId, { role: "user", text: t });
                  } catch (e) {
                    wsSend(ws, { type: "error", error: `INTERVIEW_SAVE_INPUT_FAILED: ${normalizePrivateWsError(e)}` });
                  }
                }
              }
            }

            if (sig.outputTranscription) {
              wsSend(ws, { type: "output_transcription", text: sig.outputTranscription });

              if (isInterview && interviewId && shouldPersistTranscriptChunk(sig.outputTranscription)) {
                const t = sig.outputTranscription.trim();
                if (t && t !== lastSavedAssistantTr) {
                  lastSavedAssistantTr = t;
                  try {
                    await addInterviewMessage(db, authUser.uid, interviewId, { role: "assistant", text: t });
                  } catch (e) {
                    wsSend(ws, { type: "error", error: `INTERVIEW_SAVE_OUTPUT_FAILED: ${normalizePrivateWsError(e)}` });
                  }
                }
              }
            }

            if (sig.outputAudio) {
              wsSend(ws, {
                type: "output_audio",
                dataBase64: sig.outputAudio.dataBase64,
                mimeType: sig.outputAudio.mimeType
              });
            }
          },
          onerror: (e: any) => {
            wsSend(ws, { type: "error", error: normalizePrivateWsError(e) });
          },
          onclose: () => {
            try {
              ws.close(1000, "Live session closed");
            } catch {}
          }
        }
      });

      ws.on("message", async (buf) => {
        const s = typeof buf === "string" ? buf : buf.toString("utf8");
        const msg = safeJsonParse(s) as ClientMsg | null;
        if (!msg || typeof msg.type !== "string") return;

        try {
          if (msg.type === "input_audio") {
            const mimeType = msg.mimeType || "audio/pcm;rate=16000";
            await session.sendRealtimeInput({
              audio: { data: msg.dataBase64, mimeType }
            });
            return;
          }

          if (msg.type === "input_text") {
            await session.sendClientContent({
              turns: [{ role: "user", parts: [{ text: msg.text }] }],
              turnComplete: true
            });
            return;
          }

          if (msg.type === "end_turn") {
            await session.sendClientContent({ turns: [], turnComplete: true });
            return;
          }

          if (msg.type === "close") {
            try {
              session.close();
            } catch {}
            try {
              ws.close(1000, "Client closed");
            } catch {}
            return;
          }
        } catch (e) {
          wsSend(ws, { type: "error", error: normalizePrivateWsError(e) });
        }
      });

      ws.on("close", () => {
        try {
          session.close();
        } catch {}
      });
    } catch (err) {
      wsSend(ws, { type: "error", error: normalizePrivateWsError(err) });
      try {
        ws.close(1011, "Server error");
      } catch {}
    }
  });

  return wss;
}
