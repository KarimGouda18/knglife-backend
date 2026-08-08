// src/config/env.ts
import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  GCP_PROJECT_ID: z.string().min(1),

  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().min(1),
  FIREBASE_PRIVATE_KEY: z.string().min(1),
  FIREBASE_STORAGE_BUCKET: z.string().min(1),

  // Vertex AI backend (replaces API-key auth; uses ADC via the Cloud Run service account).
  // "global" is the endpoint the newest Gemini models (3.x, TTS 3.1) are actually served
  // on for this project — verified directly against the API; regional endpoints
  // (us-central1 etc.) 404 for these even though they work for some older models.
  GOOGLE_CLOUD_LOCATION: z.string().min(1).default("global"),

  // Latest models confirmed reachable for this project (tested directly against the API).
  GEMINI_TEXT_MODEL: z.string().min(1).default("gemini-3.6-flash"),
  GEMINI_TTS_MODEL: z.string().min(1).default("gemini-3.1-flash-tts-preview"),
  // NOTE: gemini-3-pro-image-preview and veo-3.1 currently 404 in every region tested —
  // this project does not yet have Model Garden access granted for these PUBLIC_PREVIEW
  // models. Needs enabling via the Gemini Enterprise Agent Platform console (Model Garden)
  // or a Google Cloud support request; not fixable via API/config alone. Left as configured
  // so they pick up automatically once access is granted.
  GEMINI_IMAGE_MODEL: z.string().min(1).default("gemini-3-pro-image-preview"),
  GEMINI_REALTIME_MODEL: z.string().min(1).default("gemini-2.5-flash-native-audio-preview-12-2025"),
  VEO_VIDEO_MODEL: z.string().min(1).default("veo-3.1"),

  // Set to "true" only in development when custom Firebase tokens are needed.
  ALLOW_CUSTOM_TOKENS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true")
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
