import crypto from "node:crypto";
function nowIso() {
    return new Date().toISOString();
}
export function assistantsCollection(db) {
    return db.collection("assistants");
}
export function newAssistantId() {
    return crypto.randomUUID();
}
export async function createAssistant(db, doc) {
    const ref = assistantsCollection(db).doc(doc.id);
    await ref.set(doc, { merge: false });
    return doc;
}
export async function getAssistant(db, id) {
    const snap = await assistantsCollection(db).doc(id).get();
    if (!snap.exists)
        return null;
    return snap.data();
}
export async function updateAssistant(db, id, patch) {
    const ref = assistantsCollection(db).doc(id);
    await ref.set({ ...patch, updatedAt: nowIso() }, { merge: true });
    const snap = await ref.get();
    return snap.data();
}
export async function deleteAssistant(db, id) {
    await assistantsCollection(db).doc(id).delete();
}
export async function listOwnerAssistants(db, ownerUid, limit = 30) {
    const q = await assistantsCollection(db)
        .where("ownerUid", "==", ownerUid)
        .orderBy("updatedAt", "desc")
        .limit(limit)
        .get();
    return q.docs.map((d) => d.data());
}
export async function publishAssistant(db, id) {
    const publishedAt = nowIso();
    return updateAssistant(db, id, { isPublic: true, publishedAt });
}
export async function unpublishAssistant(db, id) {
    return updateAssistant(db, id, { isPublic: false, publishedAt: null });
}
export async function listPublicAssistants(db, limit = 30) {
    const q = await assistantsCollection(db)
        .where("isPublic", "==", true)
        .orderBy("publishedAt", "desc")
        .limit(limit)
        .get();
    return q.docs.map((d) => d.data());
}
