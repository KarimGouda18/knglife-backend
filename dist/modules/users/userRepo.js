import { computeAgeFromBirthDate } from "../../shared/utils/safety.js";
function nowIso() {
    return new Date().toISOString();
}
export function isProfileCompleted(p) {
    return Boolean(p.name?.trim() &&
        p.surname?.trim() &&
        p.birthDate &&
        (p.gender ?? "").trim() &&
        (p.visualDisabilityLevel ?? "").trim() &&
        p.bio?.trim());
}
function isAdultFromBirthDate(birthDate) {
    const age = computeAgeFromBirthDate(birthDate);
    return typeof age === "number" && age >= 18;
}
export function usersCollection(db) {
    return db.collection("users");
}
export async function getOrCreateUserProfile(db, uid, email) {
    const ref = usersCollection(db).doc(uid);
    const snap = await ref.get();
    if (snap.exists) {
        const p = snap.data();
        const computedAge = computeAgeFromBirthDate(p.birthDate);
        const shouldDisableNsfw = p.nsfwEnabled && !isAdultFromBirthDate(p.birthDate);
        const shouldUpdateAge = computedAge !== p.age;
        if (shouldDisableNsfw || shouldUpdateAge) {
            const patch = {
                age: computedAge,
                updatedAt: nowIso()
            };
            if (shouldDisableNsfw)
                patch.nsfwEnabled = false;
            await ref.set(patch, { merge: true });
            return { ...p, ...patch };
        }
        return p;
    }
    const created = {
        uid,
        email,
        name: "",
        surname: "",
        birthDate: null,
        age: null,
        gender: null,
        visualDisabilityLevel: "other",
        photoURL: null,
        bio: "",
        nsfwEnabled: false,
        onboardingCompleted: false,
        createdAt: nowIso(),
        updatedAt: nowIso()
    };
    await ref.set(created, { merge: false });
    return created;
}
export async function updateUserProfile(db, uid, patch) {
    const ref = usersCollection(db).doc(uid);
    const next = { ...patch };
    if ("birthDate" in patch) {
        next.age = computeAgeFromBirthDate(patch.birthDate ?? null);
    }
    next.updatedAt = nowIso();
    await ref.set(next, { merge: true });
    const snap = await ref.get();
    return snap.data();
}
