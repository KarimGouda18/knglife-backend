// src/modules/groupConversations/groupConversationsRepo.ts
import type { Firestore } from "firebase-admin/firestore";
import crypto from "node:crypto";
import type { MessagePart } from "../conversations/conversationsRepo.js";

export type GroupConversationMessageDoc = {
  id: string;
  role: "user" | "assistant";

  // quando role=assistant
  assistantId?: string;
  assistantName?: string;

  content: string;
  parts: MessagePart[];

  createdAt: string;
};

export type GroupConversationDoc = {
  id: string;
  ownerUid: string;

  groupId: string;
  title: string | null;

  createdAt: string;
  updatedAt: string;
};

const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

export function groupConversationsCol(db: Firestore) {
  return db.collection("groupConversations");
}

export function groupMessagesCol(db: Firestore, conversationId: string) {
  return groupConversationsCol(db).doc(conversationId).collection("messages");
}

export async function createGroupConversation(
  db: Firestore,
  input: Omit<GroupConversationDoc, "createdAt" | "updatedAt">
) {
  const doc: GroupConversationDoc = { ...input, createdAt: nowIso(), updatedAt: nowIso() };
  await groupConversationsCol(db).doc(doc.id).set(doc, { merge: false });
  return doc;
}

export async function getGroupConversation(db: Firestore, id: string) {
  const snap = await groupConversationsCol(db).doc(id).get();
  if (!snap.exists) return null;
  return snap.data() as GroupConversationDoc;
}

export async function listOwnerGroupConversations(db: Firestore, ownerUid: string, limit = 30) {
  const q = await groupConversationsCol(db).where("ownerUid", "==", ownerUid).orderBy("updatedAt", "desc").limit(limit).get();
  return q.docs.map((d) => d.data() as GroupConversationDoc);
}

export async function deleteGroupConversation(db: Firestore, id: string) {
  await groupConversationsCol(db).doc(id).delete();
}

export async function addGroupMessage(
  db: Firestore,
  conversationId: string,
  msg: Omit<GroupConversationMessageDoc, "id" | "createdAt">
) {
  const doc: GroupConversationMessageDoc = { ...msg, id: newId(), createdAt: nowIso() };
  await groupMessagesCol(db, conversationId).doc(doc.id).set(doc, { merge: false });
  await groupConversationsCol(db).doc(conversationId).set({ updatedAt: nowIso() }, { merge: true });
  return doc;
}

export async function listGroupMessages(db: Firestore, conversationId: string, limit = 60) {
  const q = await groupMessagesCol(db, conversationId).orderBy("createdAt", "asc").limit(limit).get();
  return q.docs.map((d) => d.data() as GroupConversationMessageDoc);
}
