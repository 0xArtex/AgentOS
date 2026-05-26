/**
 * twitterapi.io client — used for two admin-side operations:
 *
 *   1. Country detection at pool-add time. After the seed login succeeds we
 *      hit /twitter/user/info, parse the location string, and tag the row so
 *      `palmyr twitter buy --country US` can filter on it.
 *
 *   2. Suspension verification during disputes. When a buyer files a dispute
 *      claiming "suspended", we hit the same endpoint and check the account
 *      state. If twitterapi.io confirms suspended → auto-replace/refund flow
 *      runs without admin involvement.
 *
 * Pay-per-request — twitterapi.io bills per call, not by subscription. This
 * stays on the admin/operational side (seeding + dispute verify) and is not
 * exposed to public buyers.
 *
 * Env: TWITTER_API_IO_KEY. If unset, all helpers return null and callers
 * degrade: poolAdd falls back to the admin-provided --country flag, disputes
 * flag for admin_review.
 */

const BASE = "https://api.twitterapi.io";

function apiKey(): string | null {
  return process.env.TWITTER_API_IO_KEY || null;
}

export type AccountStatus = "active" | "suspended" | "not_found" | "unknown";

/**
 * Source the X account is registered from — drives the `--source` filter at
 * buy time. twitterapi.io returns this in `about_profile.source` as e.g.
 * 'Web' or 'Mobile'; we lowercase to keep the column case-stable.
 */
export type AccountSource = "web" | "mobile" | string;

export interface UserInfo {
  username: string;
  country: string | null;          // ISO 3166-1 alpha-2 when derivable
  location_raw: string | null;     // X-reported free-form location string
  status: AccountStatus;
  // ─── from twitterapi.io's about_profile (newer expanded response) ───
  /** Free-text "United States, California" — prefer this over location_raw for the country derivation. */
  account_based_in: string | null;
  /** twitterapi.io's own location confidence flag. */
  location_accurate: boolean | null;
  /** 'web' | 'mobile' | other-lowercased; null when about_profile is absent. */
  source: AccountSource | null;
  /** Org handle this account is affiliated with, if any. */
  affiliate_username: string | null;
  /** Number of times the @handle has been renamed (0 = never). */
  username_change_count: number | null;
}

/**
 * Fetch profile metadata + suspension state. Returns null when the API is
 * unreachable / the key is missing — callers must treat null as "no signal"
 * (NOT as "active") and route to admin review.
 */
export async function getUserInfo(username: string): Promise<UserInfo | null> {
  const key = apiKey();
  if (!key) return null;
  if (!username) return null;
  const handle = username.replace(/^@/, "");

  try {
    const url = `${BASE}/twitter/user/info?userName=${encodeURIComponent(handle)}`;
    const res = await fetch(url, { headers: { "x-api-key": key } });

    if (res.status === 404) {
      return emptyUserInfo(handle, "not_found");
    }
    if (!res.ok) {
      console.warn(`[twitter-api] ${handle} → HTTP ${res.status}`);
      return null;
    }

    const body = await res.json() as any;
    // twitterapi.io's user/info endpoint returns the user object either at
    // top-level or under `.data` depending on plan tier; accept both.
    const data = body?.data || body;

    // Suspension flag — across response shapes we've seen, any of these can
    // appear. Conservative OR-fold so we don't miss a real signal.
    const isSuspended =
      data?.suspended === true ||
      data?.is_suspended === true ||
      data?.status === "suspended" ||
      String(data?.account_status || "").toLowerCase() === "suspended";

    // about_profile is the newer expanded shape with richer signals. May be
    // absent on accounts/plan-tiers that don't surface it — every field
    // below has to tolerate undefined.
    const about = data?.about_profile || {};
    const account_based_in: string | null =
      about?.account_based_in || null;
    const location_raw: string | null =
      data?.location ||
      data?.profile_location?.full_name ||
      data?.user?.location ||
      null;
    const location_accurate: boolean | null =
      typeof about?.location_accurate === "boolean" ? about.location_accurate : null;
    const source: string | null = about?.source
      ? String(about.source).toLowerCase().trim() || null
      : null;
    const affiliate_username: string | null = about?.affiliate_username || null;
    // twitterapi.io returns count as a string — parse defensively, treat
    // anything non-numeric as null (no signal) rather than 0 (no renames).
    const rawCount = about?.username_changes?.count;
    const parsedCount = rawCount == null ? null : Number(rawCount);
    const username_change_count: number | null =
      typeof parsedCount === "number" && Number.isFinite(parsedCount) && parsedCount >= 0
        ? Math.floor(parsedCount)
        : null;

    return {
      username: handle,
      country: parseLocationToCountryCode(account_based_in || location_raw),
      location_raw,
      status: isSuspended ? "suspended" : "active",
      account_based_in,
      location_accurate,
      source,
      affiliate_username,
      username_change_count,
    };
  } catch (e: any) {
    console.warn(`[twitter-api] ${handle} threw:`, e?.message || e);
    return null;
  }
}

function emptyUserInfo(username: string, status: AccountStatus): UserInfo {
  return {
    username,
    country: null,
    location_raw: null,
    status,
    account_based_in: null,
    location_accurate: null,
    source: null,
    affiliate_username: null,
    username_change_count: null,
  };
}

/**
 * Best-effort ISO-alpha-2 inference from a free-text location. X locations
 * are unconstrained ("New York", "Earth", "wherever the wifi is good"), so
 * we cover common cases and return null for the rest. Admin can always
 * override at seed time via `--country`.
 */
export function parseLocationToCountryCode(loc: string | null): string | null {
  if (!loc) return null;
  const lower = loc.toLowerCase().trim();

  // Country-name and common-alias map. Order matters: longer/more specific
  // strings before shorter ones so "south korea" doesn't get caught by "korea".
  const ALIAS_TO_CODE: Array<[string, string]> = [
    ["united states", "US"], ["u.s.a", "US"], ["u.s.", "US"], ["usa", "US"], ["america", "US"],
    ["united kingdom", "GB"], ["england", "GB"], ["scotland", "GB"], ["wales", "GB"],
    ["northern ireland", "GB"], ["britain", "GB"], [" uk", "GB"], ["uk ", "GB"],
    ["canada", "CA"], ["deutschland", "DE"], ["germany", "DE"], ["france", "FR"],
    ["netherlands", "NL"], ["holland", "NL"], ["spain", "ES"], ["italy", "IT"],
    ["australia", "AU"], ["new zealand", "NZ"],
    ["japan", "JP"], ["south korea", "KR"], ["korea", "KR"], ["china", "CN"],
    ["india", "IN"], ["pakistan", "PK"], ["bangladesh", "BD"],
    ["brazil", "BR"], ["brasil", "BR"], ["mexico", "MX"], ["méxico", "MX"],
    ["argentina", "AR"], ["chile", "CL"], ["colombia", "CO"], ["peru", "PE"],
    ["nigeria", "NG"], ["south africa", "ZA"], ["kenya", "KE"], ["egypt", "EG"],
    ["philippines", "PH"], ["indonesia", "ID"], ["vietnam", "VN"], ["thailand", "TH"],
    ["malaysia", "MY"], ["singapore", "SG"],
    ["turkey", "TR"], ["türkiye", "TR"], ["russia", "RU"], ["ukraine", "UA"],
    ["poland", "PL"], ["sweden", "SE"], ["norway", "NO"], ["finland", "FI"],
    ["denmark", "DK"], ["ireland", "IE"], ["portugal", "PT"], ["greece", "GR"],
    ["belgium", "BE"], ["switzerland", "CH"], ["austria", "AT"],
    ["uae", "AE"], ["united arab emirates", "AE"], ["saudi arabia", "SA"],
    ["israel", "IL"], ["iran", "IR"], ["iraq", "IQ"],
  ];

  for (const [needle, code] of ALIAS_TO_CODE) {
    if (lower.includes(needle)) return code;
  }

  // "Austin, TX" / "Brooklyn, NY" — two-letter US state suffix is a strong
  // US signal even when "United States" isn't spelled out.
  if (/,\s*[A-Za-z]{2}\s*$/.test(loc.trim())) return "US";

  return null;
}
