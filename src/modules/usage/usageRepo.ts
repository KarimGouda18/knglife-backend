// src/modules/usage/usageRepo.ts
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { PlanId } from "../../config/plans.js";
import { planLimits } from "../../config/plans.js";
import { addMonthsIso } from "../../shared/utils/period.js";
import { LimitExceededError, type UsageMetric } from "../../shared/errors/limitExceeded.js";

// ---------------------------------------------------------------------------
// Daily usage (messages, call minutes) — one doc per UTC day, self-resetting.
// ---------------------------------------------------------------------------

export type DailyUsage = {
  messages: number;
  callSeconds: number;
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" (UTC)
}

function usageDocRef(db: Firestore, uid: string, dateKey: string) {
  return db.collection("users").doc(uid).collection("usage").doc(dateKey);
}

export async function getUsageToday(db: Firestore, uid: string): Promise<DailyUsage> {
  const snap = await usageDocRef(db, uid, todayKey()).get();
  if (!snap.exists) return { messages: 0, callSeconds: 0 };
  const d = snap.data() as Partial<DailyUsage>;
  return { messages: d.messages ?? 0, callSeconds: d.callSeconds ?? 0 };
}

/**
 * Atomically checks the daily message quota and increments it if there's room.
 * Throws LimitExceededError if the increment would exceed the plan's daily limit.
 */
export async function checkAndIncrement(db: Firestore, uid: string, plan: PlanId, amount = 1): Promise<void> {
  const limit = planLimits(plan).messagesPerDay;
  const ref = usageDocRef(db, uid, todayKey());

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = (snap.exists ? (snap.data() as Partial<DailyUsage>).messages : 0) ?? 0;

    if (limit !== null && current + amount > limit) {
      throw new LimitExceededError("messages", plan);
    }

    tx.set(ref, { messages: current + amount }, { merge: true });
  });
}

/** Best-effort increment of today's call seconds; never throws (used post-hoc on socket close). */
export async function incrementUsageBestEffort(db: Firestore, uid: string, callSeconds: number): Promise<void> {
  if (callSeconds <= 0) return;
  const ref = usageDocRef(db, uid, todayKey());
  try {
    await ref.set({ callSeconds: FieldValue.increment(callSeconds) }, { merge: true });
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

// ---------------------------------------------------------------------------
// Plan period (images, videos, renewal date, cancel-at-period-end) — resets
// once per billing period (monthly), tracked directly on the user doc so plan
// changes/cancellation and quota resets stay in one atomic transaction.
// ---------------------------------------------------------------------------

export type PlanPeriodFields = {
  plan: PlanId;
  planPeriodStart: string;
  planRenewsAt: string;
  planCancelAtPeriodEnd: boolean;
  imagesUsedInPeriod: number;
  videosUsedInPeriod: number;
};

function readPeriodFields(data: any, nowIso: string): PlanPeriodFields {
  return {
    plan: (data?.plan as PlanId) ?? "base",
    planPeriodStart: data?.planPeriodStart ?? nowIso,
    planRenewsAt: data?.planRenewsAt ?? addMonthsIso(nowIso, 1),
    planCancelAtPeriodEnd: !!data?.planCancelAtPeriodEnd,
    imagesUsedInPeriod: data?.imagesUsedInPeriod ?? 0,
    videosUsedInPeriod: data?.videosUsedInPeriod ?? 0
  };
}

/** Rolls a plan-period forward past any elapsed renewal dates (handles being offline for >1 period). */
function rollIfDue(fields: PlanPeriodFields, nowIso: string): { changed: boolean; next: PlanPeriodFields } {
  let next = { ...fields };
  let changed = false;
  const now = new Date(nowIso).getTime();
  let guard = 0;

  while (new Date(next.planRenewsAt).getTime() <= now && guard < 24) {
    guard++;
    changed = true;

    if (next.planCancelAtPeriodEnd && next.plan !== "base") {
      next.plan = "base";
      next.planCancelAtPeriodEnd = false;
    }

    const newStart = next.planRenewsAt;
    next.planPeriodStart = newStart;
    next.planRenewsAt = addMonthsIso(newStart, 1);
    next.imagesUsedInPeriod = 0;
    next.videosUsedInPeriod = 0;
  }

  return { changed, next };
}

/**
 * Reads the user's plan-period, rolling it forward (and persisting) if the renewal date has
 * passed. This is the source of truth for "what plan is the user actually on right now" —
 * call it before any plan-gated check so a scheduled cancellation takes effect immediately.
 */
export async function ensurePlanPeriod(db: Firestore, uid: string): Promise<PlanPeriodFields> {
  const ref = db.collection("users").doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const nowIso = new Date().toISOString();
    const fields = readPeriodFields(snap.data(), nowIso);
    const { changed, next } = rollIfDue(fields, nowIso);

    if (changed || !snap.data()?.planRenewsAt) {
      tx.set(ref, { ...next, updatedAt: nowIso }, { merge: true });
    }

    return next;
  });
}

/**
 * Atomically rolls the plan-period forward if due, then checks and increments the
 * per-period images/videos quota. Throws LimitExceededError if the plan's quota is exhausted.
 */
export async function checkAndIncrementPeriodMetric(
  db: Firestore,
  uid: string,
  metric: "images" | "videos",
  amount = 1
): Promise<void> {
  const ref = db.collection("users").doc(uid);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const nowIso = new Date().toISOString();
    const fields = readPeriodFields(snap.data(), nowIso);
    const { next } = rollIfDue(fields, nowIso);

    const limits = planLimits(next.plan);
    const limit = metric === "images" ? limits.imagesPerPeriod : limits.videosPerPeriod;
    const currentCount = metric === "images" ? next.imagesUsedInPeriod : next.videosUsedInPeriod;

    if (limit !== null && currentCount + amount > limit) {
      throw new LimitExceededError(metric, next.plan);
    }

    if (metric === "images") next.imagesUsedInPeriod = currentCount + amount;
    else next.videosUsedInPeriod = currentCount + amount;

    tx.set(ref, { ...next, updatedAt: nowIso }, { merge: true });
  });
}
