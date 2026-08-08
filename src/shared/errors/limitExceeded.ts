// src/shared/errors/limitExceeded.ts
import type { PlanId } from "../../config/plans.js";

export type UsageMetric = "messages" | "images" | "videos" | "callMinutes";

export class LimitExceededError extends Error {
  statusCode = 402;
  code = "LIMIT_REACHED";
  details: { limit: UsageMetric; plan: PlanId };

  constructor(limit: UsageMetric, plan: PlanId) {
    super(`Daily limit reached: ${limit}`);
    this.details = { limit, plan };
  }
}

export class PlanFeatureLockedError extends Error {
  statusCode = 403;
  code: string;
  details: { plan: PlanId };

  constructor(code: string, message: string, plan: PlanId) {
    super(message);
    this.code = code;
    this.details = { plan };
  }
}
