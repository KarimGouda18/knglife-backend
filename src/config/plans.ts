// src/config/plans.ts

export type PlanId = "base" | "bronze" | "silver" | "gold" | "platinum";

export type PlanLimits = {
  priceEur: number;
  /** null = unlimited. Never counts the initial voice Interview. */
  callMinutesPerDay: number | null;
  imagesPerDay: number | null;
  videosPerDay: number | null;
  /** Global per-user count across 1:1 chat, group chat and the text Interview. */
  messagesPerDay: number | null;
  groupsEnabled: boolean;
  /** Max assistants per group (members = assistants + the owning user). null = unlimited. */
  groupMaxAssistants: number | null;
  voiceMessagesAllowed: boolean;
  /** Max assistants that can have Nudges enabled at once. 0 = disabled. null = unlimited. */
  nudgesMaxAssistants: number | null;
};

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  base: {
    priceEur: 0,
    callMinutesPerDay: 5,
    imagesPerDay: 10,
    videosPerDay: 3,
    messagesPerDay: 100,
    groupsEnabled: false,
    groupMaxAssistants: 0,
    voiceMessagesAllowed: false,
    nudgesMaxAssistants: 0
  },
  bronze: {
    priceEur: 9.99,
    callMinutesPerDay: 15,
    imagesPerDay: 20,
    videosPerDay: 6,
    messagesPerDay: 500,
    groupsEnabled: true,
    groupMaxAssistants: 2,
    voiceMessagesAllowed: false,
    nudgesMaxAssistants: 1
  },
  silver: {
    priceEur: 19.99,
    callMinutesPerDay: 30,
    imagesPerDay: 60,
    videosPerDay: 12,
    messagesPerDay: 1500,
    groupsEnabled: true,
    groupMaxAssistants: 9,
    voiceMessagesAllowed: true,
    nudgesMaxAssistants: 3
  },
  gold: {
    priceEur: 34.99,
    callMinutesPerDay: 60,
    imagesPerDay: 90,
    videosPerDay: 20,
    messagesPerDay: 3000,
    groupsEnabled: true,
    groupMaxAssistants: 19,
    voiceMessagesAllowed: true,
    nudgesMaxAssistants: 10
  },
  platinum: {
    priceEur: 99.99,
    callMinutesPerDay: null,
    imagesPerDay: null,
    videosPerDay: null,
    messagesPerDay: null,
    groupsEnabled: true,
    groupMaxAssistants: null,
    voiceMessagesAllowed: true,
    nudgesMaxAssistants: null
  }
};

export function isPlanId(v: unknown): v is PlanId {
  return v === "base" || v === "bronze" || v === "silver" || v === "gold" || v === "platinum";
}

export function planLimits(plan: PlanId): PlanLimits {
  return PLAN_LIMITS[plan];
}
