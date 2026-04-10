// src/routes/api/voices.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../shared/middleware/requireAuth.js";
import { getGenAI } from "../../config/genai.js";
import { env } from "../../config/env.js";

export const apiVoicesRouter = Router();

// ---------------------------------------------------------------------------
// Voice catalogue
// ---------------------------------------------------------------------------

/** Gender classification for a Gemini prebuilt TTS voice. */
type VoiceGender = "male" | "female" | "neutral";

interface VoiceEntry {
  name: string;
  gender: VoiceGender;
  description: string;
}

/**
 * Complete list of Gemini prebuilt TTS voices.
 * Source: Google GenAI TTS documentation (as of 2025-Q4 / 2026-Q1).
 * Gender and description are curated from official Google documentation.
 */
const GEMINI_TTS_VOICES: VoiceEntry[] = [
  { name: "Zephyr",          gender: "female",  description: "Bright" },
  { name: "Puck",            gender: "male",    description: "Upbeat" },
  { name: "Charon",          gender: "male",    description: "Informative" },
  { name: "Kore",            gender: "female",  description: "Firm" },
  { name: "Fenrir",          gender: "male",    description: "Excitable" },
  { name: "Leda",            gender: "female",  description: "Youthful" },
  { name: "Orus",            gender: "male",    description: "Firm" },
  { name: "Aoede",           gender: "female",  description: "Breezy" },
  { name: "Callirrhoe",      gender: "female",  description: "Easy-going" },
  { name: "Autonoe",         gender: "female",  description: "Bright" },
  { name: "Enceladus",       gender: "male",    description: "Breathy" },
  { name: "Iapetus",         gender: "male",    description: "Clear" },
  { name: "Umbriel",         gender: "male",    description: "Easy-going" },
  { name: "Algieba",         gender: "male",    description: "Smooth" },
  { name: "Despina",         gender: "female",  description: "Smooth" },
  { name: "Erinome",         gender: "female",  description: "Clear" },
  { name: "Algenib",         gender: "male",    description: "Gravelly" },
  { name: "Rasalased",       gender: "male",    description: "Informative" },
  { name: "Laomedeia",       gender: "female",  description: "Upbeat" },
  { name: "Achernar",        gender: "male",    description: "Soft" },
  { name: "Alnilam",         gender: "male",    description: "Firm" },
  { name: "Schedar",         gender: "male",    description: "Even" },
  { name: "Gacrux",          gender: "male",    description: "Mature" },
  { name: "Pulcherrima",     gender: "female",  description: "Forward" },
  { name: "Achird",          gender: "neutral", description: "Friendly" },
  { name: "Zubenelgenubi",   gender: "neutral", description: "Casual" },
  { name: "Vindemiatrix",    gender: "female",  description: "Gentle" },
  { name: "Sadachbia",       gender: "neutral", description: "Lively" },
  { name: "Sadaltager",      gender: "male",    description: "Knowledgeable" },
  { name: "Sulafat",         gender: "female",  description: "Warm" }
];

const VALID_VOICE_NAMES = new Set(GEMINI_TTS_VOICES.map((v) => v.name));

// ---------------------------------------------------------------------------
// GET /api/voices
// ---------------------------------------------------------------------------

/**
 * Returns the list of all available Gemini TTS voices, grouped by gender.
 * No authentication required — safe to call before a user session is established.
 */
apiVoicesRouter.get("/", (_req, res) => {
  return res.status(200).json({ ok: true, voices: GEMINI_TTS_VOICES });
});

// ---------------------------------------------------------------------------
// POST /api/voices/preview
// ---------------------------------------------------------------------------

/**
 * Generates a short TTS audio sample for the requested voice using the
 * Gemini TTS model. Returns the audio as a base64-encoded string.
 *
 * The frontend should decode the base64 and play it via the Web Audio API
 * (PCM at 24 kHz, mono, 16-bit little-endian).
 */
apiVoicesRouter.post("/preview", requireAuth, async (req, res, next) => {
  try {
    const Body = z.object({
      voiceName: z.string().min(1).max(100),
      text: z.string().min(1).max(300).optional()
    });
    const { voiceName, text } = Body.parse(req.body);

    if (!VALID_VOICE_NAMES.has(voiceName)) {
      return res.status(400).json({ ok: false, error: "UNKNOWN_VOICE_NAME" });
    }

    const sampleText = text ?? "Ciao! Sono qui per aiutarti.";

    const ai = getGenAI();
    const response = await ai.models.generateContent({
      model: env.GEMINI_TTS_MODEL,
      contents: [{ parts: [{ text: sampleText }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      } as any
    });

    const part = response.candidates?.[0]?.content?.parts?.[0];
    const audioBase64: string | undefined = (part as any)?.inlineData?.data;
    const mimeType: string = (part as any)?.inlineData?.mimeType ?? "audio/pcm;rate=24000";

    if (!audioBase64) {
      return res.status(502).json({ ok: false, error: "TTS_NO_AUDIO_RETURNED" });
    }

    return res.status(200).json({ ok: true, audioBase64, mimeType });
  } catch (err) {
    return next(err);
  }
});
