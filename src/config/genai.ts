// src/config/genai.ts
import { GoogleGenAI } from "@google/genai";
import { env } from "./env.js";

let client: GoogleGenAI | null = null;

export function getGenAI() {
  if (client) return client;
  client = new GoogleGenAI({
    vertexai: true,
    project: env.GCP_PROJECT_ID,
    location: env.GOOGLE_CLOUD_LOCATION
  });
  return client;
}
