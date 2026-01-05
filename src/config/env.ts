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

  GEMINI_API_KEY: z.string().min(1),

  GEMINI_TEXT_MODEL: z.string().min(1).default("gemini-3-pro-preview"),
  GEMINI_IMAGE_MODEL: z.string().min(1).default("gemini-3-pro-image-preview"),
  GEMINI_REALTIME_MODEL: z.string().min(1).default("gemini-2.5-flash-native-audio-preview-12-2025"),
  VEO_VIDEO_MODEL: z.string().min(1).default("veo-3.1"),

  // Sicurezza: in produzione tienilo false. In dev puoi metterlo true se serve.
  ALLOW_CUSTOM_TOKENS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true")
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
