// src/modules/conversations/conversationsRepo.ts
import type { Firestore } from "firebase-admin/firestore";
import crypto from "node:crypto";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "inline_data"; mimeType: string; dataBase64: string };

export type MessageDoc = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: MessagePart[];
  createdAt: string;
};

export type ConversationDoc = {
  id: string;
  ownerUid: string;
  assistantId: string;
  title: string | null;
  nsfwEnabled: boolean; // snapshot dall'assistente
  createdAt: string;
  updatedAt: string;
};

const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

export function conversationsCol(db: Firestore) {
  return db.collection("conversations");
}

export function messagesCol(db: Firestore, conversationId: string) {
  return conversationsCol(db).doc(conversationId).collection("messages");
}

export async function createConversation(
  db: Firestore,
  input: Omit<ConversationDoc, "createdAt" | "updatedAt">
) {
  const doc: ConversationDoc = { ...input, createdAt: nowIso(), updatedAt: nowIso() };
  await conversationsCol(db).doc(doc.id).set(doc, { merge: false });
  return doc;
}

export async function getConversation(db: Firestore, id: string) {
  const snap = await conversationsCol(db).doc(id).get();
  if (!snap.exists) return null;
  return snap.data() as ConversationDoc;
}

export async function listOwnerConversations(db: Firestore, ownerUid: string, limit = 30) {
  const q = await conversationsCol(db)
    .where("ownerUid", "==", ownerUid)
    .orderBy("updatedAt", "desc")
    .limit(limit)
    .get();

  return q.docs.map((d) => d.data() as ConversationDoc);
}

export async function deleteConversation(db: Firestore, id: string) {
  // Nota: per semplicità v1 non cancelliamo in cascata i messaggi.
  // In seguito possiamo usare Cloud Functions / scheduled cleanup.
  await conversationsCol(db).doc(id).delete();
}

export async function addMessage(
  db: Firestore,
  conversationId: string,
  msg: Omit<MessageDoc, "id" | "createdAt">
) {
  const doc: MessageDoc = { ...msg, id: newId(), createdAt: nowIso() };
  await messagesCol(db, conversationId).doc(doc.id).set(doc, { merge: false });
  await conversationsCol(db).doc(conversationId).set({ updatedAt: nowIso() }, { merge: true });
  return doc;
}

export async function listMessages(db: Firestore, conversationId: string, limit = 40) {
  const q = await messagesCol(db, conversationId).orderBy("createdAt", "asc").limit(limit).get();
  return q.docs.map((d) => d.data() as MessageDoc);
}
