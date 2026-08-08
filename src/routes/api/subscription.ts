// src/routes/api/subscription.ts
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../shared/middleware/requireAuth.js";
import { getFirestore } from "../../config/firebase.js";
import { getOrCreateUserProfile, updateUserProfile, effectivePlan } from "../../modules/users/userRepo.js";
import { listOwnerAssistants } from "../../modules/assistants/assistantsRepo.js";
import { getUsageToday } from "../../modules/usage/usageRepo.js";
import { PLAN_LIMITS, isPlanId, planLimits } from "../../config/plans.js";
import { sanitizeDeep } from "../../shared/utils/sanitizeDeep.js";

export const apiSubscriptionRouter = Router();
apiSubscriptionRouter.use(requireAuth);

async function subscriptionSnapshot(db: FirebaseFirestore.Firestore, uid: string, email: string | null) {
  const userProfile = await getOrCreateUserProfile(db, uid, email);
  const plan = effectivePlan(userProfile);
  const [usageToday, ownedAssistants] = await Promise.all([
    getUsageToday(db, uid),
    listOwnerAssistants(db, uid, 500)
  ]);
  const nudgesEnabledCount = ownedAssistants.filter((a) => a.nudge?.enabled === true).length;

  return {
    ok: true,
    plan,
    limits: planLimits(plan),
    usageToday: {
      messages: usageToday.messages,
      images: usageToday.images,
      videos: usageToday.videos,
      callMinutes: Math.floor(usageToday.callSeconds / 60)
    },
    nudgesEnabledCount
  };
}

apiSubscriptionRouter.get("/", async (req, res, next) => {
  try {
    const db = getFirestore();
    const snapshot = await subscriptionSnapshot(db, req.user!.uid, req.user!.email ?? null);
    return res.status(200).json(sanitizeDeep(snapshot));
  } catch (err) {
    return next(err);
  }
});

/**
 * Activates a plan for the authenticated user. This is a FAKE paywall: no real
 * payment is verified here. Replace with a real payment-provider webhook
 * (Stripe/RevenueCat/App Store/Play Billing) before shipping real billing.
 */
apiSubscriptionRouter.post("/", async (req, res, next) => {
  try {
    const Body = z.object({ plan: z.string() });
    const { plan } = Body.parse(req.body);

    if (!isPlanId(plan)) {
      return res.status(400).json({ ok: false, error: "INVALID_PLAN", validPlans: Object.keys(PLAN_LIMITS) });
    }

    const db = getFirestore();
    await updateUserProfile(db, req.user!.uid, { plan, planUpdatedAt: new Date().toISOString() });

    const snapshot = await subscriptionSnapshot(db, req.user!.uid, req.user!.email ?? null);
    return res.status(200).json(sanitizeDeep(snapshot));
  } catch (err) {
    return next(err);
  }
});
