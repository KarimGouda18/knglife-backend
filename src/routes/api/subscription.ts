// src/routes/api/subscription.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../shared/middleware/requireAuth.js";
import { getFirestore } from "../../config/firebase.js";
import { getOrCreateUserProfile, updateUserProfile } from "../../modules/users/userRepo.js";
import { listOwnerAssistants } from "../../modules/assistants/assistantsRepo.js";
import { getUsageToday, ensurePlanPeriod } from "../../modules/usage/usageRepo.js";
import { addMonthsIso } from "../../shared/utils/period.js";
import { PLAN_LIMITS, isPlanId, planLimits } from "../../config/plans.js";
import { sanitizeDeep } from "../../shared/utils/sanitizeDeep.js";

export const apiSubscriptionRouter = Router();
apiSubscriptionRouter.use(requireAuth);

async function subscriptionSnapshot(db: FirebaseFirestore.Firestore, uid: string) {
  const period = await ensurePlanPeriod(db, uid);
  const [usageToday, ownedAssistants] = await Promise.all([
    getUsageToday(db, uid),
    listOwnerAssistants(db, uid, 500)
  ]);
  const nudgesEnabledCount = ownedAssistants.filter((a) => a.nudge?.enabled === true).length;

  return {
    ok: true,
    plan: period.plan,
    limits: planLimits(period.plan),
    renewsAt: period.planRenewsAt,
    cancelAtPeriodEnd: period.planCancelAtPeriodEnd,
    usage: {
      messagesToday: usageToday.messages,
      callMinutesToday: Math.floor(usageToday.callSeconds / 60),
      imagesInPeriod: period.imagesUsedInPeriod,
      videosInPeriod: period.videosUsedInPeriod
    },
    nudgesEnabledCount
  };
}

apiSubscriptionRouter.get("/", async (req, res, next) => {
  try {
    const db = getFirestore();
    await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);
    const snapshot = await subscriptionSnapshot(db, req.user!.uid);
    return res.status(200).json(sanitizeDeep(snapshot));
  } catch (err) {
    return next(err);
  }
});

/**
 * Manages the authenticated user's plan. This is a FAKE paywall: no real payment is
 * verified here. Replace with a real payment-provider webhook (Stripe/RevenueCat/App
 * Store/Play Billing) before shipping real billing.
 *
 * Body is one of:
 * - { plan: PlanId }             — activates a plan immediately (simulated payment),
 *                                   starting a fresh billing period.
 * - { cancelAtPeriodEnd: bool }  — schedules (or undoes) reverting to "base" at the
 *                                   current period's renewal date, without changing
 *                                   the active plan right away.
 */
const Body = z
  .object({
    plan: z.string().optional(),
    cancelAtPeriodEnd: z.boolean().optional()
  })
  .refine((b) => b.plan !== undefined || b.cancelAtPeriodEnd !== undefined, {
    message: "Provide either 'plan' or 'cancelAtPeriodEnd'."
  });

apiSubscriptionRouter.post("/", async (req, res, next) => {
  try {
    const input = Body.parse(req.body);
    const db = getFirestore();
    const uid = req.user!.uid;

    await getOrCreateUserProfile(db, uid, req.user!.email ?? null);

    if (input.plan !== undefined) {
      if (!isPlanId(input.plan)) {
        return res.status(400).json({ ok: false, error: "INVALID_PLAN", validPlans: Object.keys(PLAN_LIMITS) });
      }

      const now = new Date().toISOString();
      await updateUserProfile(db, uid, {
        plan: input.plan,
        planUpdatedAt: now,
        planPeriodStart: now,
        planRenewsAt: addMonthsIso(now, 1),
        planCancelAtPeriodEnd: false,
        imagesUsedInPeriod: 0,
        videosUsedInPeriod: 0
      });
    } else {
      // cancelAtPeriodEnd toggle only — resolve current plan first so cancelling an
      // already-expired/base plan is rejected rather than silently accepted.
      const period = await ensurePlanPeriod(db, uid);
      if (period.plan === "base") {
        return res.status(400).json({ ok: false, error: "NO_ACTIVE_SUBSCRIPTION" });
      }
      await updateUserProfile(db, uid, { planCancelAtPeriodEnd: !!input.cancelAtPeriodEnd });
    }

    const snapshot = await subscriptionSnapshot(db, uid);
    return res.status(200).json(sanitizeDeep(snapshot));
  } catch (err) {
    return next(err);
  }
});
