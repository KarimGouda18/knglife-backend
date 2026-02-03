import crypto from "node:crypto";
const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
export function interviewsCol(db, uid) {
    return db.collection("users").doc(uid).collection("interviews");
}
export function interviewMessagesCol(db, uid, interviewId) {
    return interviewsCol(db, uid).doc(interviewId).collection("messages");
}
export async function createInterview(db, uid, nsfwEnabled) {
    const id = newId();
    const doc = {
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
export async function getInterview(db, uid, interviewId) {
    const snap = await interviewsCol(db, uid).doc(interviewId).get();
    return snap.exists ? snap.data() : null;
}
export async function addInterviewMessage(db, uid, interviewId, msg) {
    const doc = { ...msg, id: newId(), createdAt: nowIso() };
    await interviewMessagesCol(db, uid, interviewId).doc(doc.id).set(doc, { merge: false });
    await interviewsCol(db, uid).doc(interviewId).set({ updatedAt: nowIso() }, { merge: true });
    return doc;
}
export async function listInterviewMessages(db, uid, interviewId, limit = 80) {
    const q = await interviewMessagesCol(db, uid, interviewId).orderBy("createdAt", "asc").limit(limit).get();
    return q.docs.map((d) => d.data());
}
export async function finishInterview(db, uid, interviewId, resultBio) {
    await interviewsCol(db, uid)
        .doc(interviewId)
        .set({
        status: "finished",
        resultBio,
        updatedAt: nowIso()
    }, { merge: true });
}
