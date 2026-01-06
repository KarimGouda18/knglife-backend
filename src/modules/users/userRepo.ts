// src/modules/users/userRepo.ts
import type { Firestore } from "firebase-admin/firestore";
import { computeAgeFromBirthDate } from "../../shared/utils/safety.js";

export type VisualDisabilityLevel = "none" | "low_vision" | "blind" | "other";

export type UserProfile = {
  uid: string;
  email: string | null;

  name: string;
  surname: string;

  // Ora il backend calcola age da birthDate
  birthDate: string | null; // ISO date, es: "2004-01-06"
  age: number | null;

  gender: string | null;
  visualDisabilityLevel: VisualDisabilityLevel;

  photoURL: string | null;
  bio: string;

  nsfwEnabled: boolean;

  createdAt: string;
  updatedAt: string;
};

function nowIso() {
  return new Date().toISOString();
}

export function usersCollection(db: Firestore) {
  return db.collection("users");
}

export async function getOrCreateUserProfile(db: Firestore, uid: string, email: string | null) {
  const ref = usersCollection(db).doc(uid);
  const snap = await ref.get();

  if (snap.exists) {
    const p = snap.data() as UserProfile;

    // Se birthDate presente, garantiamo age coerente (senza rompere nulla)
    const computedAge = computeAgeFromBirthDate(p.birthDate);
    if (computedAge !== p.age) {
      await ref.set({ age: computedAge, updatedAt: nowIso() }, { merge: true });
      return { ...p, age: computedAge, updatedAt: nowIso() };
    }

    return p;
  }

  const created: UserProfile = {
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

    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  await ref.set(created, { merge: false });
  return created;
}

export async function updateUserProfile(
  db: Firestore,
  uid: string,
  patch: Partial<UserProfile>
): Promise<UserProfile> {
  const ref = usersCollection(db).doc(uid);

  const next: Partial<UserProfile> = { ...patch };

  // Se cambia birthDate, ricalcoliamo age
  if ("birthDate" in patch) {
    next.age = computeAgeFromBirthDate(patch.birthDate ?? null);
  }

  next.updatedAt = nowIso();
  await ref.set(next, { merge: true });

  const snap = await ref.get();
  return snap.data() as UserProfile;
}
