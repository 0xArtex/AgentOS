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
  /**
   * Stable numeric account id (Twitter `rest_id`, returned by twitterapi.io as
   * `id`). Survives @handle renames, so it's the ONLY reliable way to tell a
   * genuinely suspended/deleted account apart from one that was merely
   * REBRANDED — a rename 404s the old handle but preserves this id. The
   * dispute service relies on it to stop rebrand-then-dispute refund fraud.
   * Null when twitterapi.io doesn't surface it.
   */
  rest_id: string | null;
  country: string | null;          // ISO 3166-1 alpha-2 when derivable
  location_raw: string | null;     // X-reported free-form location string
  status: AccountStatus;
  // ─── from twitterapi.io's about_profile (newer expanded response) ───
  /** Free-text "United States, California" — prefer this over location_raw for the country derivation. */
  account_based_in: string | null;
  /** twitterapi.io's own location confidence flag. */
  location_accurate: boolean | null;
  /**
   * Raw "Connected via" string from X — e.g. "United Kingdom Android App",
   * "iPhone", "Twitter Web App". Encodes country-of-registration AND
   * platform together; parsed into the next two fields.
   */
  source: AccountSource | null;
  /** ISO alpha-2 parsed out of source ("United Kingdom Android App" → GB). */
  registered_country: string | null;
  /** 'android' | 'ios' | 'web' — parsed from source. null if no match. */
  registered_platform: "android" | "ios" | "web" | null;
  /** Org handle this account is affiliated with, if any. */
  affiliate_username: string | null;
  /** Number of times the @handle has been renamed (0 = never). */
  username_change_count: number | null;
}

/**
 * Fetch about-profile + status via twitterapi.io's `/twitter/user_about`.
 *
 * That endpoint is the authoritative source for `account_based_in` — the
 * residency country X surfaces in the "About this account" panel. The older
 * `location` field on a user's profile is free-text the user types
 * themselves (sellers often spoof it to "USA"), so we DELIBERATELY ignore
 * it for country derivation. account_based_in is the only signal we trust.
 *
 * Status mapping:
 *   200 with data    → "active"
 *   200 with status=error → "unknown" (treat as no signal — admin review)
 *   404              → "not_found" (suspended or deleted — dispute service
 *                      handles both the same way)
 *   any other        → null (no signal)
 *
 * The endpoint does NOT include a suspension flag in 200 responses — X
 * removes suspended profiles entirely, so a 404 is the signal. This is why
 * the dispute service treats not_found identically to suspended.
 *
 * Docs: https://docs.twitterapi.io/api-reference/endpoint/get_user_about
 */
export async function getUserInfo(username: string): Promise<UserInfo | null> {
  const key = apiKey();
  if (!key) return null;
  if (!username) return null;
  const handle = username.replace(/^@/, "");

  try {
    const url = `${BASE}/twitter/user_about?userName=${encodeURIComponent(handle)}`;
    const res = await fetch(url, { headers: { "X-API-Key": key } });

    if (res.status === 404) {
      return emptyUserInfo(handle, "not_found");
    }
    if (!res.ok) {
      console.warn(`[twitter-api] ${handle} → HTTP ${res.status}`);
      return null;
    }

    const body = await res.json() as any;
    // user_about wraps the payload in { data, status, msg }. status='error'
    // means the call succeeded HTTP-wise but the API can't service this
    // handle (e.g. plan-tier limit) — treat as no signal.
    if (body?.status === "error") {
      console.warn(`[twitter-api] ${handle} returned status=error:`, body?.msg);
      return null;
    }
    const data = body?.data || body;
    const about = data?.about_profile || {};

    // Stable numeric id — captured here so the row can be re-checked by id
    // later even after a rename. twitterapi.io returns it as `id`.
    const rest_id: string | null = data?.id != null ? String(data.id) : null;
    const account_based_in: string | null = about?.account_based_in || null;
    const location_accurate: boolean | null =
      typeof about?.location_accurate === "boolean" ? about.location_accurate : null;
    const source: string | null = about?.source
      ? String(about.source).toLowerCase().trim() || null
      : null;
    const { country: registered_country, platform: registered_platform } = parseRegistration(source);
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
      rest_id,
      // Country derives ONLY from account_based_in. We used to fall back to
      // the user-set `location` field but that's spoofable — accounts sold
      // as "American" typed "USA" into their profile location while X's
      // about_profile correctly reports their real country.
      country: parseLocationToCountryCode(account_based_in),
      location_raw: account_based_in,
      status: "active",
      account_based_in,
      location_accurate,
      source,
      registered_country,
      registered_platform,
      affiliate_username,
      username_change_count,
    };
  } catch (e: any) {
    console.warn(`[twitter-api] ${handle} threw:`, e?.message || e);
    return null;
  }
}

/**
 * Look up an account by its STABLE numeric id (`rest_id`) via twitterapi.io's
 * batch endpoint. Unlike a handle lookup, the id survives a username change —
 * so this is what distinguishes a genuinely suspended/deleted account (id gone)
 * from one that was merely RENAMED (old handle 404s, but the id still resolves
 * to a LIVE account under a new @handle). The dispute service uses this to stop
 * rebrand-then-dispute refund fraud.
 *
 * `/twitter/user/batch_info_by_ids?userIds=<id>` returns
 * `{ users: [...], status, msg }`. Suspended/deleted ids are NOT omitted — they
 * come back in `users` with `unavailable: true` (+ `unavailableReason`). So:
 *
 *   live account        → status "active" (+ the account's CURRENT userName,
 *                         which may differ from the handle we recorded — that
 *                         divergence IS the rebrand signal)
 *   unavailable / empty → status "not_found" (genuinely gone)
 *   API error / no key  → null (no signal — caller routes to admin review)
 *
 * Docs: https://docs.twitterapi.io/api-reference/endpoint/batch_get_user_by_userids
 */
export async function getUserInfoById(restId: string): Promise<UserInfo | null> {
  const key = apiKey();
  if (!key) return null;
  const id = restId ? String(restId).trim() : "";
  if (!id) return null;

  try {
    const url = `${BASE}/twitter/user/batch_info_by_ids?userIds=${encodeURIComponent(id)}`;
    const res = await fetch(url, { headers: { "X-API-Key": key } });
    if (!res.ok) {
      console.warn(`[twitter-api] id ${id} → HTTP ${res.status}`);
      return null;
    }

    const body = await res.json() as any;
    // Same { users, status, msg } envelope contract as user_about — status
    // 'error' means the call couldn't be serviced (plan tier, etc.) → no signal.
    if (body?.status === "error") {
      console.warn(`[twitter-api] id ${id} returned status=error:`, body?.msg);
      return null;
    }

    const users: any[] = Array.isArray(body?.users) ? body.users : [];
    const user = users.find((u) => String(u?.id) === id) || users[0] || null;
    if (!user) {
      // id resolves to nothing at all → deleted / gone.
      return { ...emptyUserInfo("", "not_found"), rest_id: id };
    }

    const handle = user?.userName ? String(user.userName).replace(/^@/, "") : "";
    if (user?.unavailable === true || user?.unavailableReason) {
      // suspended / deleted — genuinely gone.
      return { ...emptyUserInfo(handle, "not_found"), rest_id: id };
    }

    // Live account. Surface the CURRENT handle so the caller can detect a
    // rebrand (recorded handle !== current handle).
    return { ...emptyUserInfo(handle, "active"), rest_id: id };
  } catch (e: any) {
    console.warn(`[twitter-api] id ${id} threw:`, e?.message || e);
    return null;
  }
}

function emptyUserInfo(username: string, status: AccountStatus): UserInfo {
  return {
    username,
    rest_id: null,
    country: null,
    location_raw: null,
    status,
    account_based_in: null,
    location_accurate: null,
    source: null,
    registered_country: null,
    registered_platform: null,
    affiliate_username: null,
    username_change_count: null,
  };
}

/**
 * Split twitterapi.io's `about_profile.source` into a country code + platform.
 *
 * Real-world examples seen in prod (all lowercased here):
 *   "united kingdom android app"  → { country: "GB", platform: "android" }
 *   "argentina android app"        → { country: "AR", platform: "android" }
 *   "russian federation android app" → { country: "RU", platform: "android" }
 *   "iphone"                       → { country: null, platform: "ios" }
 *   "twitter web app"              → { country: null, platform: "web" }
 *   "tweetdeck web app"            → { country: null, platform: "web" }
 *   "web"                          → { country: null, platform: "web" }
 *   null / ""                      → { country: null, platform: null }
 *
 * Anything unrecognised returns nulls — the row stays seedable but won't
 * match `--registered-country` / `--platform` filters until admin tags it.
 */
export function parseRegistration(source: string | null): {
  country: string | null;
  platform: "android" | "ios" | "web" | null;
} {
  if (!source) return { country: null, platform: null };
  const lower = source.toLowerCase();

  let platform: "android" | "ios" | "web" | null = null;
  if (/\bandroid\b/.test(lower)) platform = "android";
  else if (/\b(iphone|ipad|ios)\b/.test(lower)) platform = "ios";
  else if (/\b(web|tweetdeck)\b/.test(lower)) platform = "web";

  // Strip every platform/app/marketing token, leaving the country fragment.
  // Order-insensitive — `replace(/\b…\b/g, "")` removes each match wherever
  // it lands. "twitter" is intentionally stripped so "Twitter Web App"
  // parses to platform=web, country=null instead of trying to map "twitter".
  const countryPart = lower
    .replace(/\b(android|ios|iphone|ipad|tablet|web|app|tweetdeck|mobile|twitter|x)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const country = countryPart ? parseLocationToCountryCode(countryPart) : null;
  return { country, platform };
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
