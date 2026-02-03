import crypto from "node:crypto";
const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
export function groupConversationsCol(db) {
    return db.collection("groupConversations");
}
export function groupMessagesCol(db, conversationId) {
    return groupConversationsCol(db).doc(conversationId).collection("messages");
}
export async function createGroupConversation(db, input) {
    const doc = { ...input, createdAt: nowIso(), updatedAt: nowIso() };
    await groupConversationsCol(db).doc(doc.id).set(doc, { merge: false });
    return doc;
}
export async function getGroupConversation(db, id) {
    const snap = await groupConversationsCol(db).doc(id).get();
    if (!snap.exists)
        return null;
    return snap.data();
}
export async function listOwnerGroupConversations(db, ownerUid, limit = 30) {
    const q = await groupConversationsCol(db).where("ownerUid", "==", ownerUid).orderBy("updatedAt", "desc").limit(limit).get();
    return q.docs.map((d) => d.data());
}
export async function deleteGroupConversation(db, id) {
    await groupConversationsCol(db).doc(id).delete();
}
export async function addGroupMessage(db, conversationId, msg) {
    const doc = { ...msg, id: newId(), createdAt: nowIso() };
    await groupMessagesCol(db, conversationId).doc(doc.id).set(doc, { merge: false });
    await groupConversationsCol(db).doc(conversationId).set({ updatedAt: nowIso() }, { merge: true });
    return doc;
}
export async function listGroupMessages(db, conversationId, limit = 60) {
    const q = await groupMessagesCol(db, conversationId).orderBy("createdAt", "asc").limit(limit).get();
    return q.docs.map((d) => d.data());
}
