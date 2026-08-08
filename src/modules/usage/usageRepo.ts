// src/modules/usage/usageRepo.ts
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { PlanId } from "../../config/plans.js";
import { planLimits } from "../../config/plans.js";
import { LimitExceededError, type UsageMetric } from "../../shared/errors/limitExceeded.js";

export type DailyUsage = {
  messages: number;
  images: number;
  videos: number;
  callSeconds: number;
};

const EMPTY_USAGE: DailyUsage = { messages: 0, images: 0, videos: 0, callSeconds: 0 };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" (UTC)
}

function usageDocRef(db: Firestore, uid: string, dateKey: string) {
  return db.collection("users").doc(uid).collection("usage").doc(dateKey);
}

export async function getUsageToday(db: Firestore, uid: string): Promise<DailyUsage> {
  const snap = await usageDocRef(db, uid, todayKey()).get();
  if (!snap.exists) return { ...EMPTY_USAGE };
  const d = snap.data() as Partial<DailyUsage>;
  return {
    messages: d.messages ?? 0,
    images: d.images ?? 0,
    videos: d.videos ?? 0,
    callSeconds: d.callSeconds ?? 0
  };
}

const METRIC_TO_USAGE_FIELD: Record<UsageMetric, keyof DailyUsage> = {
  messages: "messages",
  images: "images",
  videos: "videos",
  callMinutes: "callSeconds"
};

/** Daily-limit field on PlanLimits for a given usage metric, or null if the metric has no cap for this plan. */
function limitForMetric(plan: PlanId, metric: UsageMetric): number | null {
  const limits = planLimits(plan);
  if (metric === "messages") return limits.messagesPerDay;
  if (metric === "images") return limits.imagesPerDay;
  if (metric === "videos") return limits.videosPerDay;
  return limits.callMinutesPerDay === null ? null : limits.callMinutesPerDay * 60;
}

/**
 * Atomically checks a daily quota and increments it if there's room.
 * `amount` is in the usage doc's native unit (count for messages/images/videos, seconds for callMinutes).
 * Throws LimitExceededError if the increment would exceed the plan's daily limit.
 */
export async function checkAndIncrement(
  db: Firestore,
  uid: string,
  plan: PlanId,
  metric: UsageMetric,
  amount = 1
): Promise<void> {
  const limit = limitForMetric(plan, metric);
  const field = METRIC_TO_USAGE_FIELD[metric];
  const ref = usageDocRef(db, uid, todayKey());

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = (snap.exists ? (snap.data() as Partial<DailyUsage>)[field] : 0) ?? 0;

    if (limit !== null && current + amount > limit) {
      throw new LimitExceededError(metric, plan);
    }

    tx.set(ref, { [field]: current + amount }, { merge: true });
  });
}

/** Best-effort increment that never throws (used for post-hoc accounting, e.g. call duration on socket close). */
export async function incrementUsageBestEffort(
  db: Firestore,
  uid: string,
  metric: UsageMetric,
  amount: number
): Promise<void> {
  if (amount <= 0) return;
  const field = METRIC_TO_USAGE_FIELD[metric];
  const ref = usageDocRef(db, uid, todayKey());
  try {
    await ref.set({ [field]: FieldValue.increment(amount) }, { merge: true });
  } catch {
    // best-effort — ignore
  }
}

/** Remaining seconds of call time today for the plan, or null if unlimited. */
export async function remainingCallSeconds(db: Firestore, uid: string, plan: PlanId): Promise<number | null> {
  const limitMinutes = planLimits(plan).callMinutesPerDay;
  if (limitMinutes === null) return null;
  const usage = await getUsageToday(db, uid);
  return Math.max(0, limitMinutes * 60 - usage.callSeconds);
}
