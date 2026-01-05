// src/modules/users/userRepo.ts
import type { Firestore } from "firebase-admin/firestore";

export type VisualDisabilityLevel = "none" | "low_vision" | "blind" | "other";

export type UserProfile = {
  uid: string;
  email: string | null;

  name: string;
  surname: string;
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
    return snap.data() as UserProfile;
  }

  const created: UserProfile = {
    uid,
    email,

    name: "",
    surname: "",
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

export async function updateUserProfile(db: Firestore, uid: string, patch: Partial<UserProfile>) {
  const ref = usersCollection(db).doc(uid);

  const updatedAt = nowIso();
  const toWrite = { ...patch, updatedAt };

  await ref.set(toWrite, { merge: true });

  const snap = await ref.get();
  return snap.data() as UserProfile;
}
