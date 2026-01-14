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
import { addInterviewMessage, createInterview, getInterview } from "../modules/interview/interviewRepo.js";

/**
 * Protocollo WS (client -> server):
 * - { type: "input_audio", dataBase64: string, mimeType?: string }  // default: audio/pcm;rate=16000
 * - { type: "input_text", text: string }                           // opzionale (debug)
 * - { type: "end_turn" }                                           // forza flush (interview)
 * - { type: "close" }
 *
 * Server -> client:
 * - { type: "ready", session: {...}, interviewId?: string }
 * - { type: "output_audio", dataBase64: string, mimeType: string }
 * - { type: "output_transcription", text: string }
 * - { type: "input_transcription", text: string }
 * - { type: "raw", message: any }
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
  return assistant?.voiceName || "Kore";
}

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

function normalizeSpaces(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

class TranscriptSaver {
  private readonly db: ReturnType<typeof getFirestore>;
  private readonly uid: string;
  private readonly interviewId: string;

  private userBuf = "";
  private assistantBuf = "";

  private userTimer: NodeJS.Timeout | null = null;
  private assistantTimer: NodeJS.Timeout | null = null;

  private readonly FLUSH_MS = 900;
  private readonly MIN_LEN = 8; // abbassato un filo per non perdere risposte brevi
  private readonly MAX_BUF = 2000;

  constructor(db: ReturnType<typeof getFirestore>, uid: string, interviewId: string) {
    this.db = db;
    this.uid = uid;
    this.interviewId = interviewId;
  }

  private mergeIncremental(prev: string, next: string) {
    const p = normalizeSpaces(prev);
    const n = normalizeSpaces(next);

    if (!p) return n;
    if (!n) return p;

    if (n.startsWith(p)) return n;
    if (p.startsWith(n)) return p;

    return normalizeSpaces(`${p} ${n}`);
  }

  private shouldSave(text: string) {
    const t = normalizeSpaces(text);
    if (!t) return false;
    if (t.length < this.MIN_LEN) return false;
    return true;
  }

  private scheduleFlush(role: "user" | "assistant") {
    const old = role === "user" ? this.userTimer : this.assistantTimer;
    if (old) clearTimeout(old);

    const timer = setTimeout(() => {
      void this.flush(role);
    }, this.FLUSH_MS);

    if (role === "user") this.userTimer = timer;
    else this.assistantTimer = timer;
  }

  appendUserChunk(chunk: string) {
    const c = normalizeSpaces(chunk);
    if (!c) return;
    this.userBuf = this.mergeIncremental(this.userBuf, c);
    if (this.userBuf.length >= this.MAX_BUF) void this.flush("user");
    else this.scheduleFlush("user");
  }

  appendAssistantChunk(chunk: string) {
    const c = normalizeSpaces(chunk);
    if (!c) return;
    this.assistantBuf = this.mergeIncremental(this.assistantBuf, c);
    if (this.assistantBuf.length >= this.MAX_BUF) void this.flush("assistant");
    else this.scheduleFlush("assistant");
  }

  async flush(role: "user" | "assistant") {
    if (role === "user") {
      if (this.userTimer) clearTimeout(this.userTimer);
      this.userTimer = null;

      const text = normalizeSpaces(this.userBuf);
      this.userBuf = "";

      if (!this.shouldSave(text)) return;
      await addInterviewMessage(this.db, this.uid, this.interviewId, { role: "user", text });
      return;
    }

    if (this.assistantTimer) clearTimeout(this.assistantTimer);
    this.assistantTimer = null;

    const text = normalizeSpaces(this.assistantBuf);
    this.assistantBuf = "";

    if (!this.shouldSave(text)) return;
    await addInterviewMessage(this.db, this.uid, this.interviewId, { role: "assistant", text });
  }

  async flushAll() {
    await Promise.allSettled([this.flush("user"), this.flush("assistant")]);
  }
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

    // keepalive ping
    const pingInterval = setInterval(() => {
      try {
        if (ws.readyState === ws.OPEN) ws.ping();
      } catch {}
    }, 25_000);

    try {
      const authUser = await verifyIdTokenFromReq(req);
      if (!authUser) {
        wsSend(ws, { type: "error", error: "MISSING_ID_TOKEN (use Authorization Bearer or ?idToken=...)" });
        ws.close(1008, "Unauthorized");
        clearInterval(pingInterval);
        return;
      }

      const db = getFirestore();
      const userProfile = await getOrCreateUserProfile(db, authUser.uid, authUser.email);

      const ai = getGenAI();

      const isInterview = pathname === "/api/live/interview";
      let systemPrompt = "";
      let assistant: any = null;
      let voiceName = "Kore";

      let interviewId: string | null = null;
      let interviewNsfwEnabled = false;
      let transcriptSaver: TranscriptSaver | null = null;

      if (isInterview) {
        // ✅ se il client passa interviewId, usiamo QUELLO (se valido)
        const requestedInterviewId = url.searchParams.get("interviewId");

        if (requestedInterviewId) {
          const existing = await getInterview(db, authUser.uid, requestedInterviewId);
          if (existing && existing.ownerUid === authUser.uid && existing.status === "active") {
            interviewId = existing.id;
            interviewNsfwEnabled = existing.nsfwEnabled;
          }
        }

        // fallback: crea nuova
        if (!interviewId) {
          const interview = await createInterview(db, authUser.uid, userProfile.nsfwEnabled);
          interviewId = interview.id;
          interviewNsfwEnabled = interview.nsfwEnabled;
        }

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

        transcriptSaver = new TranscriptSaver(db, authUser.uid, interviewId);
      } else {
        const m = pathname.match(/^\/api\/live\/assistants\/([^/]+)$/);
        const assistantId = m?.[1];
        if (!assistantId) {
          wsSend(ws, { type: "error", error: "MISSING_ASSISTANT_ID" });
          ws.close(1008, "Bad request");
          clearInterval(pingInterval);
          return;
        }

        assistant = await getAssistant(db, assistantId);
        if (!assistant || assistant.ownerUid !== authUser.uid) {
          wsSend(ws, { type: "error", error: "ASSISTANT_NOT_FOUND" });
          ws.close(1008, "Not found");
          clearInterval(pingInterval);
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
        },
        callbacks: {
          onopen: async () => {
            // ✅ mando interviewId anche top-level per compatibilità client
            wsSend(ws, {
              type: "ready",
              interviewId: interviewId ?? undefined,
              session: {
                mode: isInterview ? "interview" : "assistant",
                voiceName,
                model: env.GEMINI_REALTIME_MODEL,
                interviewId: interviewId ?? undefined
              }
            });

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
              if (isInterview && transcriptSaver) {
                try {
                  transcriptSaver.appendUserChunk(sig.inputTranscription);
                } catch {}
              }
            }

            if (sig.outputTranscription) {
              wsSend(ws, { type: "output_transcription", text: sig.outputTranscription });
              if (isInterview && transcriptSaver) {
                try {
                  transcriptSaver.appendAssistantChunk(sig.outputTranscription);
                } catch {}
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
          onclose: async () => {
            try {
              if (isInterview && transcriptSaver) await transcriptSaver.flushAll();
            } catch {}
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
            if (isInterview && transcriptSaver) {
              try {
                await transcriptSaver.flushAll();
              } catch {}
            }
            await session.sendClientContent({ turns: [], turnComplete: true });
            return;
          }

          if (msg.type === "close") {
            try {
              if (isInterview && transcriptSaver) await transcriptSaver.flushAll();
            } catch {}
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

      ws.on("close", async () => {
        clearInterval(pingInterval);
        try {
          // best-effort flush
          if (isInterview && transcriptSaver) await transcriptSaver.flushAll();
        } catch {}
        try {
          session.close();
        } catch {}
      });
    } catch (err) {
      wsSend(ws, { type: "error", error: normalizePrivateWsError(err) });
      try {
        ws.close(1011, "Server error");
      } catch {}
      clearInterval(pingInterval);
    }
  });

  return wss;
}
