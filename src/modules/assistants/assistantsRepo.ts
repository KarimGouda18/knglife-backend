// src/modules/assistants/assistantsRepo.ts
import type { Firestore } from "firebase-admin/firestore";
import crypto from "node:crypto";

export type AvatarSpec = {
  ethnicity: string;
  heightCm: number;
  bodyType: string;
  hairStyle: string;
  hairColor: string;
  eyeColor: string;
  clothingStyle: string;
};

export type AssistantAvatar = {
  bucket: string;
  path: string;
  contentType: string;
  size: number;
  downloadUrl: string;
};

export type AssistantDoc = {
  id: string;

  ownerUid: string;

  name: string;
  surname: string;
  age: number;
  gender: string;
  relationship: string;

  bio: string;
  bioMode: "manual" | "auto";

  avatarSpec: AvatarSpec;
  avatar: AssistantAvatar | null;

  nsfwEnabled: boolean;

  // ✅ Live voice per ASSISTANT (non interview)
  voiceName: string;

  isPublic: boolean;
  publishedAt: string | null;

  // ✅ Metadati clone (opzionali, non rompono nulla)
  clonedFromAssistantId?: string | null;
  clonedFromOwnerUid?: string | null;
  clonedAt?: string | null;

  createdAt: string;
  updatedAt: string;
};

function nowIso() {
  return new Date().toISOString();
}

export function assistantsCollection(db: Firestore) {
  return db.collection("assistants");
}

export function newAssistantId() {
  return crypto.randomUUID();
}

export async function createAssistant(db: Firestore, doc: AssistantDoc) {
  const ref = assistantsCollection(db).doc(doc.id);
  await ref.set(doc, { merge: false });
  return doc;
}

export async function getAssistant(db: Firestore, id: string) {
  const snap = await assistantsCollection(db).doc(id).get();
  if (!snap.exists) return null;
  return snap.data() as AssistantDoc;
}

export async function updateAssistant(db: Firestore, id: string, patch: Partial<AssistantDoc>) {
  const ref = assistantsCollection(db).doc(id);
  await ref.set({ ...patch, updatedAt: nowIso() }, { merge: true });
  const snap = await ref.get();
  return snap.data() as AssistantDoc;
}

export async function deleteAssistant(db: Firestore, id: string) {
  await assistantsCollection(db).doc(id).delete();
}

export async function listOwnerAssistants(db: Firestore, ownerUid: string, limit = 30) {
  const q = await assistantsCollection(db)
    .where("ownerUid", "==", ownerUid)
    .orderBy("updatedAt", "desc")
    .limit(limit)
    .get();

  return q.docs.map((d) => d.data() as AssistantDoc);
}

export async function publishAssistant(db: Firestore, id: string) {
  const publishedAt = nowIso();
  return updateAssistant(db, id, { isPublic: true, publishedAt });
}

export async function unpublishAssistant(db: Firestore, id: string) {
  return updateAssistant(db, id, { isPublic: false, publishedAt: null });
}

export async function listPublicAssistants(db: Firestore, limit = 30) {
  const q = await assistantsCollection(db)
    .where("isPublic", "==", true)
    .orderBy("publishedAt", "desc")
    .limit(limit)
    .get();

  return q.docs.map((d) => d.data() as AssistantDoc);
}
