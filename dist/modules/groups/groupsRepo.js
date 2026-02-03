import crypto from "node:crypto";
import { getAssistant } from "../assistants/assistantsRepo.js";
function nowIso() {
    return new Date().toISOString();
}
export function groupsCollection(db) {
    return db.collection("groups");
}
export function newGroupId() {
    return crypto.randomUUID();
}
export async function createGroup(db, doc) {
    const ref = groupsCollection(db).doc(doc.id);
    await ref.set(doc, { merge: false });
    return doc;
}
export async function getGroup(db, id) {
    const snap = await groupsCollection(db).doc(id).get();
    if (!snap.exists)
        return null;
    return snap.data();
}
export async function updateGroup(db, id, patch) {
    const ref = groupsCollection(db).doc(id);
    await ref.set({ ...patch, updatedAt: nowIso() }, { merge: true });
    const snap = await ref.get();
    return snap.data();
}
export async function deleteGroup(db, id) {
    await groupsCollection(db).doc(id).delete();
}
export async function listOwnerGroups(db, ownerUid, limit = 30) {
    const q = await groupsCollection(db).where("ownerUid", "==", ownerUid).orderBy("updatedAt", "desc").limit(limit).get();
    return q.docs.map((d) => d.data());
}
/**
 * Valida che tutti gli assistantIds appartengano all'ownerUid e ritorna i doc degli assistenti.
 * Lancia errore se uno non esiste o non appartiene all'utente.
 */
export async function resolveGroupAssistants(opts) {
    const uniqueIds = Array.from(new Set(opts.assistantIds)).filter(Boolean);
    const assistants = [];
    for (const id of uniqueIds) {
        const a = await getAssistant(opts.db, id);
        if (!a || a.ownerUid !== opts.ownerUid) {
            throw new Error("ASSISTANT_NOT_FOUND_OR_NOT_OWNED");
        }
        assistants.push(a);
    }
    return assistants;
}
