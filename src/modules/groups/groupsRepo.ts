// src/modules/groups/groupsRepo.ts
import type { Firestore } from "firebase-admin/firestore";
import crypto from "node:crypto";
import { getAssistant, type AssistantDoc } from "../assistants/assistantsRepo.js";

export type GroupDoc = {
  id: string;
  ownerUid: string;

  name: string;
  context: string | null;

  assistantIds: string[];

  createdAt: string;
  updatedAt: string;
};

function nowIso() {
  return new Date().toISOString();
}

export function groupsCollection(db: Firestore) {
  return db.collection("groups");
}

export function newGroupId() {
  return crypto.randomUUID();
}

export async function createGroup(db: Firestore, doc: GroupDoc) {
  const ref = groupsCollection(db).doc(doc.id);
  await ref.set(doc, { merge: false });
  return doc;
}

export async function getGroup(db: Firestore, id: string) {
  const snap = await groupsCollection(db).doc(id).get();
  if (!snap.exists) return null;
  return snap.data() as GroupDoc;
}

export async function updateGroup(db: Firestore, id: string, patch: Partial<GroupDoc>) {
  const ref = groupsCollection(db).doc(id);
  await ref.set({ ...patch, updatedAt: nowIso() }, { merge: true });
  const snap = await ref.get();
  return snap.data() as GroupDoc;
}

export async function deleteGroup(db: Firestore, id: string) {
  await groupsCollection(db).doc(id).delete();
}

export async function listOwnerGroups(db: Firestore, ownerUid: string, limit = 30) {
  const q = await groupsCollection(db).where("ownerUid", "==", ownerUid).orderBy("updatedAt", "desc").limit(limit).get();
  return q.docs.map((d) => d.data() as GroupDoc);
}

/**
 * Valida che tutti gli assistantIds appartengano all'ownerUid e ritorna i doc degli assistenti.
 * Lancia errore se uno non esiste o non appartiene all'utente.
 */
export async function resolveGroupAssistants(opts: {
  db: Firestore;
  ownerUid: string;
  assistantIds: string[];
}): Promise<AssistantDoc[]> {
  const uniqueIds = Array.from(new Set(opts.assistantIds)).filter(Boolean);
  const assistants: AssistantDoc[] = [];

  for (const id of uniqueIds) {
    const a = await getAssistant(opts.db, id);
    if (!a || a.ownerUid !== opts.ownerUid) {
      throw new Error("ASSISTANT_NOT_FOUND_OR_NOT_OWNED");
    }
    assistants.push(a);
  }

  return assistants;
}
