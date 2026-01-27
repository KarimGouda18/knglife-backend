// src/modules/conversations/conversationsRepo.ts
import type { Firestore } from "firebase-admin/firestore";
import crypto from "node:crypto";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "inline_data"; mimeType: string; dataBase64: string }
  | { type: "file_url"; mimeType: string; url: string; displayName?: string };

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
  summary?: string | null;
  nsfwEnabled: boolean;
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

export async function updateConversation(db: Firestore, id: string, patch: Partial<ConversationDoc>) {
  const ref = conversationsCol(db).doc(id);
  await ref.set({ ...patch, updatedAt: nowIso() }, { merge: true });
  const snap = await ref.get();
  return snap.exists ? (snap.data() as ConversationDoc) : null;
}

export async function listOwnerConversations(db: Firestore, ownerUid: string, limit = 30) {
  const q = await conversationsCol(db)
    .where("ownerUid", "==", ownerUid)
    .orderBy("updatedAt", "desc")
    .limit(limit)
    .get();

  return q.docs.map((d) => d.data() as ConversationDoc);
}

/**
 * Lista conversazioni per assistantId (utile per cascade delete su assistant).
 * Nota: può richiedere un composite index (Firestore ti fornisce il link).
 */
export async function listOwnerConversationsByAssistant(
  db: Firestore,
  ownerUid: string,
  assistantId: string,
  limit = 200
) {
  const q = await conversationsCol(db)
    .where("ownerUid", "==", ownerUid)
    .where("assistantId", "==", assistantId)
    .orderBy("updatedAt", "desc")
    .limit(limit)
    .get();

  return q.docs.map((d) => d.data() as ConversationDoc);
}

export async function getLatestConversationByAssistant(db: Firestore, ownerUid: string, assistantId: string) {
  const q = await conversationsCol(db)
    .where("ownerUid", "==", ownerUid)
    .where("assistantId", "==", assistantId)
    .orderBy("updatedAt", "desc")
    .limit(1)
    .get();

  return q.empty ? null : (q.docs[0]!.data() as ConversationDoc);
}

export async function deleteConversation(db: Firestore, id: string) {
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

/**
 * Cancella una conversazione + tutti i messaggi (subcollection).
 * Best-effort ma robusto: cancellazione a batch per evitare limiti.
 */
export async function deleteConversationCascade(db: Firestore, conversationId: string) {
  const convoRef = conversationsCol(db).doc(conversationId);

  const col = convoRef.collection("messages");
  const chunkSize = 200;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await col.orderBy("createdAt", "asc").limit(chunkSize).get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    if (snap.size < chunkSize) break;
  }

  await convoRef.delete();
}
