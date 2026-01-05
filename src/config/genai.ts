// src/config/genai.ts
import { GoogleGenAI } from "@google/genai";
import { env } from "./env.js";

let client: GoogleGenAI | null = null;

export function getGenAI() {
  if (client) return client;
  client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return client;
}
