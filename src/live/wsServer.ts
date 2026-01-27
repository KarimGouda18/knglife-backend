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
import {
  addMessage,
  createConversation,
  getConversation,
  updateConversation,
  newId,
  type ConversationDoc
} from "../modules/conversations/conversationsRepo.js";
import { buildAssistantRecallContext } from "../modules/conversations/recall.js";
import { updateConversationSummary } from "../modules/conversations/updateSummary.js";
import { generateConversationTitle } from "../modules/conversations/generateTitle.js";
import { upsertAssistantMemory } from "../modules/assistants/assistantMemory.js";

/**
 * Protocollo WS (client -> server):
 * - { type: "input_audio", dataBase64: string, mimeType?: string }
 * - { type: "input_video", dataBase64: string, mimeType?: string }
 * - { type: "input_text", text: string }
 * - { type: "end_turn" }
 * - { type: "close" }
 *
 * Compatibilità extra:
 * - { type: "audio", dataBase64: string, mimeType?: string }
 * - { type: "video", dataBase64: string, mimeType?: string }
 * - { type: "realtime_input", audio?: {...}, video?: {...} }
 *
 * Server -> client:
 * - { type: "ready", session: {...}, interviewId?: string, conversationId?: string }
 * - { type: "output_audio", dataBase64: string, mimeType: string }
 * - { type: "output_transcription", text: string }
 * - { type: "input_transcription", text: string }
 * - { type: "raw", message: any }
 * - { type: "error", error: string }
 */

type ClientMsg =
  | { type: "input_audio"; dataBase64: string; mimeType?: string }
  | { type: "audio"; dataBase64: string; mimeType?: string }
  | { type: "input_video"; dataBase64: string; mimeType?: string }
  | { type: "video"; dataBase64: string; mimeType?: string }
  | { type: "realtime_input"; audio?: { dataBase64: string; mimeType?: string }; video?: { dataBase64: string; mimeType?: string } }
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

function normalizeInlineBase64(input: string) {
  const s = String(input ?? "");
  const idx = s.indexOf("base64,");
  if (idx >= 0) return s.slice(idx + "base64,".length).trim();
  return s.trim();
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
  private readonly MIN_LEN = 8;
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

class LiveConversationSaver {
  private readonly db: ReturnType<typeof getFirestore>;
  private readonly ownerUid: string;
  private readonly assistant: any;
  private readonly userProfile: any;

  private convo: ConversationDoc;

  private userBuf = "";
  private assistantBuf = "";

  private userTimer: NodeJS.Timeout | null = null;
  private assistantTimer: NodeJS.Timeout | null = null;

  private readonly FLUSH_MS = 900;
  private readonly MIN_LEN = 8;
  private readonly MAX_BUF = 2400;

  private pendingUserText: string | null = null;

  private assistantMemory: string;
  private recallText: string;

  constructor(opts: {
    db: ReturnType<typeof getFirestore>;
    ownerUid: string;
    assistant: any;
    userProfile: any;
    conversation: ConversationDoc;
    assistantMemory: string;
    recallText: string;
  }) {
    this.db = opts.db;
    this.ownerUid = opts.ownerUid;
    this.assistant = opts.assistant;
    this.userProfile = opts.userProfile;
    this.convo = opts.conversation;
    this.assistantMemory = opts.assistantMemory;
    this.recallText = opts.recallText;
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

      await addMessage(this.db, this.convo.id, {
        role: "user",
        content: text,
        parts: [{ type: "text", text }]
      });

      this.pendingUserText = text;
      return;
    }

    if (this.assistantTimer) clearTimeout(this.assistantTimer);
    this.assistantTimer = null;

    const text = normalizeSpaces(this.assistantBuf);
    this.assistantBuf = "";

    if (!this.shouldSave(text)) return;

    await addMessage(this.db, this.convo.id, {
      role: "assistant",
      content: text,
      parts: [{ type: "text", text }]
    });

    const lastUserText = this.pendingUserText ?? "(audio)";
    this.pendingUserText = null;

    // titolo se mancante e primo scambio (se la convo è senza titolo e non ha summary)
    const titleMissing = !this.convo.title || !this.convo.title.trim();
    const isFirstExchange = !this.convo.summary;

    const tasks: Promise<any>[] = [];

    tasks.push(
      (async () => {
        const nextSummary = await updateConversationSummary({
          user: { birthDate: this.userProfile.birthDate, nsfwEnabled: this.userProfile.nsfwEnabled },
          assistant: { nsfwEnabled: !!this.assistant.nsfwEnabled },
          previousSummary: this.convo.summary ?? null,
          lastUserText,
          lastAssistantText: text
        });
        const updated = await updateConversation(this.db, this.convo.id, { summary: nextSummary });
        if (updated) this.convo = updated;
      })()
    );

    if (titleMissing && isFirstExchange) {
      tasks.push(
        (async () => {
          const t = await generateConversationTitle({
            user: { birthDate: this.userProfile.birthDate, nsfwEnabled: this.userProfile.nsfwEnabled },
            assistant: { nsfwEnabled: !!this.assistant.nsfwEnabled },
            firstUserText: lastUserText,
            firstAssistantText: text
          });
          const updated = await updateConversation(this.db, this.convo.id, { title: t });
          if (updated) this.convo = updated;
        })()
      );
    }

    tasks.push(
      (async () => {
        const nextMem = await upsertAssistantMemory({
          db: this.db,
          ownerUid: this.ownerUid,
          assistant: {
            id: this.assistant.id,
            name: this.assistant.name,
            surname: this.assistant.surname,
            nsfwEnabled: !!this.assistant.nsfwEnabled,
            relationship: this.assistant.relationship
          },
          user: { birthDate: this.userProfile.birthDate, nsfwEnabled: this.userProfile.nsfwEnabled },
          currentMemory: this.assistantMemory,
          newConversationDelta: `Utente (live): ${lastUserText}\nAssistente (live): ${text}`
        });
        this.assistantMemory = nextMem;
      })()
    );

    await Promise.allSettled(tasks);
  }

  async flushAll() {
    await Promise.allSettled([this.flush("user"), this.flush("assistant")]);
  }

  getConversationId() {
    return this.convo.id;
  }
}

async function sendRealtimeVideoFrame(session: any, opts: { dataBase64: string; mimeType: string }) {
  const data = normalizeInlineBase64(opts.dataBase64);
  const mimeType = opts.mimeType || "image/jpeg";

  try {
    await session.sendRealtimeInput({
      video: { data, mimeType }
    });
    return;
  } catch {}

  try {
    await session.sendRealtimeInput({
      mediaChunks: [{ data, mimeType }]
    });
    return;
  } catch (e) {
    throw e;
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

    const pingInterval = setInterval(() => {
      try {
        if (ws.readyState === ws.OPEN) ws.ping();
      } catch {}
    }, 25_000);

    let vadTimer: NodeJS.Timeout | null = null;
    const VAD_SILENCE_MS = 850;

    const bumpVad = async (isInterview: boolean, session: any) => {
      if (isInterview) return;
      if (vadTimer) clearTimeout(vadTimer);
      vadTimer = setTimeout(() => {
        try {
          void session.sendClientContent({ turns: [], turnComplete: true });
        } catch {}
      }, VAD_SILENCE_MS);
    };

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

      let conversationId: string | null = null;
      let liveSaver: LiveConversationSaver | null = null;

      if (isInterview) {
        const requestedInterviewId = url.searchParams.get("interviewId");

        if (requestedInterviewId) {
          const existing = await getInterview(db, authUser.uid, requestedInterviewId);
          if (existing && existing.ownerUid === authUser.uid && existing.status === "active") {
            interviewId = existing.id;
            interviewNsfwEnabled = existing.nsfwEnabled;
          }
        }

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

        const voiceFromQuery = url.searchParams.get("voiceName");
        voiceName = (voiceFromQuery || pickVoiceName(assistant)).trim() || "Kore";

        // conversationId opzionale: se non c'è, creiamo una nuova conversazione live
        const requestedConversationId = url.searchParams.get("conversationId");
        if (requestedConversationId) {
          const existing = await getConversation(db, requestedConversationId);
          if (existing && existing.ownerUid === authUser.uid && existing.assistantId === assistant.id) {
            conversationId = existing.id;
          }
        }

        if (!conversationId) {
          const created = await createConversation(db, {
            id: newId(),
            ownerUid: authUser.uid,
            assistantId: assistant.id,
            title: null,
            summary: null,
            nsfwEnabled: assistant.nsfwEnabled
          });
          conversationId = created.id;
        }

        const convo = (await getConversation(db, conversationId))!;
        const { assistantMemory, recallText } = await buildAssistantRecallContext({
          db,
          ownerUid: authUser.uid,
          assistantId: assistant.id,
          excludeConversationId: convo.id
        });

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
            id: assistant.id,
            name: assistant.name,
            surname: assistant.surname,
            age: assistant.age,
            gender: assistant.gender,
            relationship: assistant.relationship,
            bio: assistant.bio,
            nsfwEnabled: assistant.nsfwEnabled,
            avatarSpec: assistant.avatarSpec,
            persona: assistant.persona ?? null
          },
          assistantMemory,
          recallText,
          conversationSummary: convo.summary ?? null
        });

        liveSaver = new LiveConversationSaver({
          db,
          ownerUid: authUser.uid,
          assistant,
          userProfile,
          conversation: convo,
          assistantMemory,
          recallText
        });
      }

      const safetySettings = getGeminiSafetySettings({
        userBirthDate: userProfile.birthDate,
        userNsfwEnabled: isInterview ? interviewNsfwEnabled : userProfile.nsfwEnabled,
        assistantNsfwEnabled: isInterview ? interviewNsfwEnabled : (assistant?.nsfwEnabled ?? false)
      });

      const tools = [{ googleSearch: {} }];

      const session = await ai.live.connect({
        model: env.GEMINI_REALTIME_MODEL,
        config: {
          responseModalities: ["AUDIO"],
          systemInstruction: systemPrompt,
          safetySettings,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools,

          ...(isInterview
            ? {}
            : {
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName }
                  }
                }
              })
        },
        callbacks: {
          onopen: async () => {
            wsSend(ws, {
              type: "ready",
              interviewId: interviewId ?? undefined,
              conversationId: liveSaver?.getConversationId() ?? conversationId ?? undefined,
              session: {
                mode: isInterview ? "interview" : "assistant",
                voiceName: isInterview ? undefined : voiceName,
                model: env.GEMINI_REALTIME_MODEL,
                interviewId: interviewId ?? undefined,
                conversationId: liveSaver?.getConversationId() ?? conversationId ?? undefined,
                tools: ["googleSearch"]
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

              if (!isInterview && liveSaver) {
                try {
                  liveSaver.appendUserChunk(sig.inputTranscription);
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

              if (!isInterview && liveSaver) {
                try {
                  liveSaver.appendAssistantChunk(sig.outputTranscription);
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
              if (!isInterview && liveSaver) await liveSaver.flushAll();
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
          if (msg.type === "input_audio" || msg.type === "audio") {
            const mimeType = msg.mimeType || "audio/pcm;rate=16000";
            const data = normalizeInlineBase64(msg.dataBase64);

            await session.sendRealtimeInput({
              audio: { data, mimeType }
            });

            await bumpVad(isInterview, session);
            return;
          }

          if (msg.type === "input_video" || msg.type === "video") {
            const mimeType = msg.mimeType || "image/jpeg";
            await sendRealtimeVideoFrame(session, { dataBase64: msg.dataBase64, mimeType });
            return;
          }

          if (msg.type === "realtime_input") {
            if (msg.audio?.dataBase64) {
              const mimeType = msg.audio.mimeType || "audio/pcm;rate=16000";
              const data = normalizeInlineBase64(msg.audio.dataBase64);
              await session.sendRealtimeInput({ audio: { data, mimeType } });
              await bumpVad(isInterview, session);
            }

            if (msg.video?.dataBase64) {
              const mimeType = msg.video.mimeType || "image/jpeg";
              await sendRealtimeVideoFrame(session, { dataBase64: msg.video.dataBase64, mimeType });
            }
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
            try {
              if (isInterview && transcriptSaver) await transcriptSaver.flushAll();
            } catch {}
            try {
              if (!isInterview && liveSaver) await liveSaver.flushAll();
            } catch {}

            await session.sendClientContent({ turns: [], turnComplete: true });
            return;
          }

          if (msg.type === "close") {
            try {
              if (isInterview && transcriptSaver) await transcriptSaver.flushAll();
            } catch {}
            try {
              if (!isInterview && liveSaver) await liveSaver.flushAll();
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
        if (vadTimer) clearTimeout(vadTimer);

        try {
          if (isInterview && transcriptSaver) await transcriptSaver.flushAll();
        } catch {}
        try {
          if (!isInterview && liveSaver) await liveSaver.flushAll();
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
      if (vadTimer) clearTimeout(vadTimer);
    }
  });

  return wss;
}
