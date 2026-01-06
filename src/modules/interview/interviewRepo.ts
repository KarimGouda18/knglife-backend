// src/modules/interview/interviewRepo.ts
import type { Firestore } from "firebase-admin/firestore";
import crypto from "node:crypto";

export type InterviewDoc = {
  id: string;
  ownerUid: string;
  status: "active" | "finished";
  nsfwEnabled: boolean; // snapshot dal profilo all'avvio
  createdAt: string;
  updatedAt: string;
  resultBio: string | null;
};

export type InterviewMessageDoc = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

export function interviewsCol(db: Firestore, uid: string) {
  return db.collection("users").doc(uid).collection("interviews");
}

export function interviewMessagesCol(db: Firestore, uid: string, interviewId: string) {
  return interviewsCol(db, uid).doc(interviewId).collection("messages");
}

export async function createInterview(db: Firestore, uid: string, nsfwEnabled: boolean) {
  const id = newId();
  const doc: InterviewDoc = {
    id,
    ownerUid: uid,
    status: "active",
    nsfwEnabled,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    resultBio: null
  };

  await interviewsCol(db, uid).doc(id).set(doc, { merge: false });
  return doc;
}

export async function getInterview(db: Firestore, uid: string, interviewId: string) {
  const snap = await interviewsCol(db, uid).doc(interviewId).get();
  return snap.exists ? (snap.data() as InterviewDoc) : null;
}

export async function addInterviewMessage(
  db: Firestore,
  uid: string,
  interviewId: string,
  msg: Omit<InterviewMessageDoc, "id" | "createdAt">
) {
  const doc: InterviewMessageDoc = { ...msg, id: newId(), createdAt: nowIso() };
  await interviewMessagesCol(db, uid, interviewId).doc(doc.id).set(doc, { merge: false });
  await interviewsCol(db, uid).doc(interviewId).set({ updatedAt: nowIso() }, { merge: true });
  return doc;
}

export async function listInterviewMessages(db: Firestore, uid: string, interviewId: string, limit = 80) {
  const q = await interviewMessagesCol(db, uid, interviewId).orderBy("createdAt", "asc").limit(limit).get();
  return q.docs.map((d) => d.data() as InterviewMessageDoc);
}

export async function finishInterview(db: Firestore, uid: string, interviewId: string, resultBio: string) {
  await interviewsCol(db, uid)
    .doc(interviewId)
    .set(
      {
        status: "finished",
        resultBio,
        updatedAt: nowIso()
      },
      { merge: true }
    );
}
