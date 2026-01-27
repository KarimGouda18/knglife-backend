// src/modules/conversations/recall.ts
import type { Firestore } from "firebase-admin/firestore";
import { getAssistantMemory } from "../assistants/assistantMemory.js";
import { listOwnerConversationsByAssistant, type ConversationDoc } from "./conversationsRepo.js";

function clip(s: string, max: number) {
  const t = (s ?? "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

function normalizeSpaces(s: string) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

export async function buildAssistantRecallContext(opts: {
  db: Firestore;
  ownerUid: string;
  assistantId: string;
  excludeConversationId?: string;
  maxConversations?: number;
}) {
  const memory = await getAssistantMemory(opts.db, opts.ownerUid, opts.assistantId);

  const convos = await listOwnerConversationsByAssistant(
    opts.db,
    opts.ownerUid,
    opts.assistantId,
    Math.max(10, opts.maxConversations ?? 12)
  );

  const filtered = convos.filter((c) => c.id !== opts.excludeConversationId);

  const items: ConversationDoc[] = filtered
    .filter((c) => normalizeSpaces(c.summary ?? "") || normalizeSpaces(c.title ?? ""))
    .slice(0, opts.maxConversations ?? 8);

  const recallLines: string[] = [];
  for (const c of items) {
    const title = normalizeSpaces(c.title ?? "") || "Conversazione";
    const summary = normalizeSpaces(c.summary ?? "");
    const line =
      summary
        ? `- ${clip(title, 60)}: ${clip(summary, 260)}`
        : `- ${clip(title, 60)}`;
    recallLines.push(line);
  }

  const recallText = recallLines.length ? recallLines.join("\n") : "";

  return { assistantMemory: memory, recallText };
}
