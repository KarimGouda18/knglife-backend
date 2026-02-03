import { getAuth } from "../../config/firebase.js";
/**
 * Cancella documenti in batch da una query (paginata).
 * Nota: Firestore batch max 500 operazioni, teniamo margine.
 */
async function deleteQueryInBatches(db, query, batchSize = 400) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const snap = await query.limit(batchSize).get();
        if (snap.empty)
            break;
        const batch = db.batch();
        for (const doc of snap.docs)
            batch.delete(doc.ref);
        await batch.commit();
    }
}
/**
 * Cancella tutta una subcollection di un doc (paginata).
 */
async function deleteSubcollection(db, docRef, subName) {
    const col = docRef.collection(subName);
    const q = col.orderBy("createdAt", "asc");
    await deleteQueryInBatches(db, q);
}
/**
 * Best-effort: cancella file su Storage con prefix.
 */
async function deleteStoragePrefix(bucket, prefix) {
    try {
        // deleteFiles è best-effort e può fallire per permessi/rate-limit
        await bucket.deleteFiles({ prefix });
    }
    catch (err) {
        // non blocchiamo il delete account per Storage
        // eslint-disable-next-line no-console
        console.warn("[deleteAccount] storage deleteFiles failed for prefix:", prefix, err);
    }
}
export async function deleteAccountEverywhere(opts) {
    const { db, uid, storageBucket } = opts;
    // 1) Assistants dell'utente (collection root "assistants")
    const assistantsQ = db.collection("assistants").where("ownerUid", "==", uid);
    const assistantsSnap = await assistantsQ.get();
    const assistantsCount = assistantsSnap.size;
    // Per ciascun assistente, se in futuro aggiungiamo subcollections (post, ecc),
    // qui è il punto dove cancellarle.
    // Attualmente il tuo schema non mostra subcollections sotto assistants.
    await deleteQueryInBatches(db, assistantsQ);
    // 2) Conversations dell'utente + subcollection messages
    const convQ = db.collection("conversations").where("ownerUid", "==", uid);
    const convSnap = await convQ.get();
    const conversationsCount = convSnap.size;
    // cancelliamo messages per ogni conversation
    for (const doc of convSnap.docs) {
        await deleteSubcollection(db, doc.ref, "messages");
    }
    await deleteQueryInBatches(db, convQ);
    // 3) Interview: hai moduli interview, ma la struttura potrebbe essere:
    // - interviews (root) con ownerUid
    // oppure
    // - users/{uid}/interviews
    //
    // Facciamo best-effort su entrambe.
    try {
        const rootInterviewsQ = db.collection("interviews").where("ownerUid", "==", uid);
        const rootInterviewsSnap = await rootInterviewsQ.get();
        for (const i of rootInterviewsSnap.docs) {
            await deleteSubcollection(db, i.ref, "messages");
        }
        await deleteQueryInBatches(db, rootInterviewsQ);
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[deleteAccount] root interviews cleanup skipped/failed", err);
    }
    try {
        const userInterviewsCol = db.collection("users").doc(uid).collection("interviews");
        const userInterviewsSnap = await userInterviewsCol.get();
        for (const i of userInterviewsSnap.docs) {
            await deleteSubcollection(db, i.ref, "messages");
        }
        const q = userInterviewsCol.orderBy("createdAt", "asc");
        await deleteQueryInBatches(db, q);
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[deleteAccount] users/{uid}/interviews cleanup skipped/failed", err);
    }
    // 4) User profile doc
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const userCount = userSnap.exists ? 1 : 0;
    // Se in futuro aggiungi subcollections sotto users/{uid}, qui vanno cancellate.
    // (Già gestiamo users/{uid}/interviews sopra)
    await userRef.delete().catch(() => null);
    // 5) Best-effort: Storage wipe
    if (storageBucket) {
        await deleteStoragePrefix(storageBucket, `users/${uid}/`);
        await deleteStoragePrefix(storageBucket, `assistants/${uid}/`);
    }
    // 6) Best-effort: elimina l'utente da Firebase Auth
    try {
        await getAuth().deleteUser(uid);
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[deleteAccount] auth deleteUser failed", err);
    }
    return {
        ok: true,
        deleted: {
            assistants: assistantsCount,
            conversations: conversationsCount,
            users: userCount
        }
    };
}
