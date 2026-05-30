/**
 * Timezone math for native TikTok scheduling. Pure + dependency-free so it can
 * be unit-tested in isolation.
 *
 * TikTok Studio's scheduler interprets the date/time you enter in the *browser
 * session's* timezone (which we align to the account's country). So a schedule
 * given as an absolute instant must be rendered into that zone's wall clock —
 * with DST handled — before being typed into the picker.
 */

export interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

/** Render an absolute instant into wall-clock parts in a given IANA timezone. */
export function wallClockInTz(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || "0");
  // Intl can emit hour "24" for midnight in some environments — fold to 0.
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute") };
}

export const pad2 = (n: number) => String(n).padStart(2, "0");
