// src/shared/utils/safety.ts
export type GeminiSafetyThreshold =
  | "BLOCK_NONE"
  | "BLOCK_LOW_AND_ABOVE"
  | "BLOCK_MEDIUM_AND_ABOVE"
  | "BLOCK_ONLY_HIGH";

export type GeminiSafetySetting = {
  category:
    | "HARM_CATEGORY_SEXUALLY_EXPLICIT"
    | "HARM_CATEGORY_HATE_SPEECH"
    | "HARM_CATEGORY_HARASSMENT"
    | "HARM_CATEGORY_DANGEROUS_CONTENT";
  threshold: GeminiSafetyThreshold;
};

export function computeAgeFromBirthDate(birthDateIso: string | null | undefined): number | null {
  if (!birthDateIso) return null;
  const d = new Date(birthDateIso);
  if (Number.isNaN(d.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
  if (age < 0 || age > 130) return null;
  return age;
}

export function getGeminiSafetySettings(opts: {
  userBirthDate: string | null;
  userNsfwEnabled: boolean;
  assistantNsfwEnabled: boolean;
}): GeminiSafetySetting[] {
  const age = computeAgeFromBirthDate(opts.userBirthDate);
  const isAdult = typeof age === "number" && age >= 18;

  let threshold: GeminiSafetyThreshold;

  // 1) Minorenni: BLOCK_LOW_AND_ABOVE per tutto
  if (!isAdult) {
    threshold = "BLOCK_LOW_AND_ABOVE";
  } else {
    // 2) Maggiorenne ma NSFW OFF (profilo OFF o assistente OFF): BLOCK_MEDIUM_AND_ABOVE
    // 3) Maggiorenne con profilo NSFW ON e assistente NSFW ON: BLOCK_NONE
    threshold = opts.userNsfwEnabled && opts.assistantNsfwEnabled ? "BLOCK_NONE" : "BLOCK_MEDIUM_AND_ABOVE";
  }

  return [
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold },
    { category: "HARM_CATEGORY_HARASSMENT", threshold },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold }
  ];
}
