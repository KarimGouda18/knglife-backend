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
  GOOGLE_CLOUD_LOCATION: z.string().min(1).default("us-central1"),

  GEMINI_TEXT_MODEL: z.string().min(1).default("gemini-3.5-flash"),
  GEMINI_IMAGE_MODEL: z.string().min(1).default("gemini-3-pro-image-preview"),
  GEMINI_REALTIME_MODEL: z.string().min(1).default("gemini-2.5-flash-native-audio-preview-12-2025"),
  GEMINI_TTS_MODEL: z.string().min(1).default("gemini-2.5-flash-preview-tts"),
  VEO_VIDEO_MODEL: z.string().min(1).default("veo-3.1"),

  // Set to "true" only in development when custom Firebase tokens are needed.
  ALLOW_CUSTOM_TOKENS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true")
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
