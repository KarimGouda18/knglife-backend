// src/shared/utils/period.ts

/** Adds `months` calendar months to an ISO timestamp, returning a new ISO timestamp. */
export function addMonthsIso(iso: string, months: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}
