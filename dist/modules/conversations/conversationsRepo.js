import crypto from "node:crypto";
const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
export function conversationsCol(db) {
    return db.collection("conversations");
}
export function messagesCol(db, conversationId) {
    return conversationsCol(db).doc(conversationId).collection("messages");
}
export async function createConversation(db, input) {
    const doc = { ...input, createdAt: nowIso(), updatedAt: nowIso() };
    await conversationsCol(db).doc(doc.id).set(doc, { merge: false });
    return doc;
}
export async function getConversation(db, id) {
    const snap = await conversationsCol(db).doc(id).get();
    if (!snap.exists)
        return null;
    return snap.data();
}
export async function updateConversation(db, id, patch) {
    const ref = conversationsCol(db).doc(id);
    await ref.set({ ...patch, updatedAt: nowIso() }, { merge: true });
    const snap = await ref.get();
    return snap.exists ? snap.data() : null;
}
export async function listOwnerConversations(db, ownerUid, limit = 30) {
    const q = await conversationsCol(db)
        .where("ownerUid", "==", ownerUid)
        .orderBy("updatedAt", "desc")
        .limit(limit)
        .get();
    return q.docs.map((d) => d.data());
}
/**
 * Lista conversazioni per assistantId (utile per cascade delete su assistant).
 * Nota: può richiedere un composite index (Firestore ti fornisce il link).
 */
export async function listOwnerConversationsByAssistant(db, ownerUid, assistantId, limit = 200) {
    const q = await conversationsCol(db)
        .where("ownerUid", "==", ownerUid)
        .where("assistantId", "==", assistantId)
        .orderBy("updatedAt", "desc")
        .limit(limit)
        .get();
    return q.docs.map((d) => d.data());
}
export async function getLatestConversationByAssistant(db, ownerUid, assistantId) {
    const q = await conversationsCol(db)
        .where("ownerUid", "==", ownerUid)
        .where("assistantId", "==", assistantId)
        .orderBy("updatedAt", "desc")
        .limit(1)
        .get();
    return q.empty ? null : q.docs[0].data();
}
export async function deleteConversation(db, id) {
    await conversationsCol(db).doc(id).delete();
}
export async function addMessage(db, conversationId, msg) {
    const doc = { ...msg, id: newId(), createdAt: nowIso() };
    await messagesCol(db, conversationId).doc(doc.id).set(doc, { merge: false });
    await conversationsCol(db).doc(conversationId).set({ updatedAt: nowIso() }, { merge: true });
    return doc;
}
export async function listMessages(db, conversationId, limit = 40) {
    const q = await messagesCol(db, conversationId).orderBy("createdAt", "asc").limit(limit).get();
    return q.docs.map((d) => d.data());
}
/**
 * Cancella una conversazione + tutti i messaggi (subcollection).
 * Best-effort ma robusto: cancellazione a batch per evitare limiti.
 */
export async function deleteConversationCascade(db, conversationId) {
    const convoRef = conversationsCol(db).doc(conversationId);
    const col = convoRef.collection("messages");
    const chunkSize = 200;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const snap = await col.orderBy("createdAt", "asc").limit(chunkSize).get();
        if (snap.empty)
            break;
        const batch = db.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        if (snap.size < chunkSize)
            break;
    }
    await convoRef.delete();
}
