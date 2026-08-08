// src/modules/users/userRepo.ts
import type { Firestore } from "firebase-admin/firestore";
import { computeAgeFromBirthDate } from "../../shared/utils/safety.js";
import type { PlanId } from "../../config/plans.js";

export type VisualDisabilityLevel = "none" | "low_vision" | "blind" | "other";

export type UserProfile = {
  uid: string;
  email: string | null;

  name: string;
  surname: string;

  birthDate: string | null; // "YYYY-MM-DD"
  age: number | null;

  gender: string | null;
  visualDisabilityLevel: VisualDisabilityLevel;

  photoURL: string | null;
  bio: string;

  nsfwEnabled: boolean;

  onboardingCompleted: boolean;

  /** Subscription tier. Defaults to "base" (free). */
  plan: PlanId;
  planUpdatedAt: string | null;

  /** ISO timestamp updated by the client heartbeat. Used by the nudge system to detect real inactivity. */
  lastActiveAt?: string | null;

  createdAt: string;
  updatedAt: string;
};

function nowIso() {
  return new Date().toISOString();
}

export function isProfileCompleted(p: UserProfile): boolean {
  return Boolean(
    p.name?.trim() &&
      p.surname?.trim() &&
      p.birthDate &&
      (p.gender ?? "").trim() &&
      (p.visualDisabilityLevel ?? "").trim() &&
      p.bio?.trim()
  );
}

function isAdultFromBirthDate(birthDate: string | null): boolean {
  const age = computeAgeFromBirthDate(birthDate);
  return typeof age === "number" && age >= 18;
}

export function usersCollection(db: Firestore) {
  return db.collection("users");
}

export async function getOrCreateUserProfile(db: Firestore, uid: string, email: string | null) {
  const ref = usersCollection(db).doc(uid);
  const snap = await ref.get();

  if (snap.exists) {
    const p = snap.data() as UserProfile;

    const computedAge = computeAgeFromBirthDate(p.birthDate);
    const shouldDisableNsfw = p.nsfwEnabled && !isAdultFromBirthDate(p.birthDate);
    const shouldUpdateAge = computedAge !== p.age;

    if (shouldDisableNsfw || shouldUpdateAge) {
      const patch: Partial<UserProfile> = {
        age: computedAge,
        updatedAt: nowIso()
      };
      if (shouldDisableNsfw) patch.nsfwEnabled = false;

      await ref.set(patch, { merge: true });
      return { ...p, ...patch } as UserProfile;
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
    onboardingCompleted: false,

    plan: "base",
    planUpdatedAt: null,

    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  await ref.set(created, { merge: false });
  return created;
}

/** Returns the user's plan, defaulting to "base" for profiles created before the plan field existed. */
export function effectivePlan(p: Pick<UserProfile, "plan">): PlanId {
  return p.plan ?? "base";
}

export async function updateUserProfile(db: Firestore, uid: string, patch: Partial<UserProfile>): Promise<UserProfile> {
  const ref = usersCollection(db).doc(uid);

  const next: Partial<UserProfile> = { ...patch };

  if ("birthDate" in patch) {
    next.age = computeAgeFromBirthDate(patch.birthDate ?? null);
  }

  next.updatedAt = nowIso();
  await ref.set(next, { merge: true });

  const snap = await ref.get();
  return snap.data() as UserProfile;
}
