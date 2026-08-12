/**
 * Seed a BOUGHT TikTok account into the deployable pool from supplier
 * credentials (accsmarket & co. ship `login:password:email:email_password`, not
 * cookies).
 *
 * The whole point is IP hygiene: the login runs SERVER-SIDE through the
 * account's pinned residential proxy, so the session is born on the exact IP
 * that will operate it forever — the operator's own IP never touches TikTok.
 * QR connect is the wrong tool for bought accounts (it needs the account on a
 * phone first, which puts a new device+IP on it); this is the credential path.
 *
 * Flow: register a pool row → form-login through the proxy (email-OTP + captcha
 * auto-solved by the login service) → bake the harvested session into the
 * account's persistent profile on the SAME proxy → mark 'active' (leasable). Any
 * failure lands the row in 'dead' with a diagnostic code; poolStock counts only
 * 'active', so a half-seeded account is never handed to a buyer.
 */
import { randomUUID } from "crypto";
import {
  registerPoolAccount,
  markConnected,
  setHandle,
  markDead,
  getAccount,
  AccountStatus,
} from "./tiktok-accounts";
import { loginTikTok, TikTokLoginRequest, TikTokLoginResult } from "./tiktok-login";
import { openAuthenticatedSession } from "./social-runtime";

export interface ParsedCredential {
  login: string;
  password: string;
  email?: string;
  email_password?: string;
}

const FIELD_TOKENS = new Set(["login", "password", "email", "email_password"]);
export const DEFAULT_CREDENTIAL_FORMAT = "login:password:email:email_password";

/**
 * Split a supplier credentials line into fields using a colon-delimited FORMAT
 * template that names each position. Suppliers ship a handful of shapes:
 *   login:password:email:email_password     (the common one — the default)
 *   login:password:email_password           (login IS the email)
 *   login::password:email:email_password    (an empty second field)
 * The template makes parsing explicit instead of guessed — the operator knows
 * their service's format (the listing states it). Positional split on ':'; a
 * password that itself contains ':' would misalign every field, so a count
 * mismatch is a hard, explanatory error rather than silently-wrong data.
 */
export function parseCredentialLine(line: string, format: string = DEFAULT_CREDENTIAL_FORMAT): ParsedCredential {
  const names = format.split(":").map((s) => s.trim());
  const values = line.trim().split(":");
  if (values.length !== names.length) {
    throw new Error(
      `credentials line has ${values.length} colon-separated parts but format "${format}" expects ${names.length}. ` +
      `A ':' inside a password shifts every field — fix the line or pass the format that matches this supplier.`,
    );
  }
  const out: Record<string, string> = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (!name) continue; // empty token (the "::" variant) — that position is ignored
    if (!FIELD_TOKENS.has(name)) {
      throw new Error(`unknown format field "${name}" — use only login, password, email, email_password`);
    }
    out[name] = values[i];
  }
  if (!out.login || !out.password) {
    throw new Error(`format "${format}" must map both login and password`);
  }
  // Login-is-email shape: no explicit email field, but the login is one — reuse
  // it so the device-verification email-OTP auto-solver has an inbox to read.
  if (!out.email && /@/.test(out.login)) out.email = out.login;
  return {
    login: out.login,
    password: out.password,
    email: out.email || undefined,
    email_password: out.email_password || undefined,
  };
}

export interface SeedCredentialsInput extends ParsedCredential {
  country?: string;
  tag?: string;
}

export interface SeedStartResult {
  account_id: string;
  proxy_session_id: string;
  status: AccountStatus;
}

export interface SeedOutcome {
  ok: boolean;
  status: AccountStatus;
  handle?: string | null;
  error?: string;
  error_code?: string;
}

export interface SeedDeps {
  login: (req: TikTokLoginRequest) => Promise<TikTokLoginResult>;
  persist: (opts: { accountId: string; proxySessionId: string; country?: string; cookies: any[] }) => Promise<void>;
}

/**
 * Bake a harvested session into the account's persistent profile on its pinned
 * proxy — the exact profile every later op replays from. The login minted the
 * session on this IP; this just materialises it on disk so the account survives
 * a browser close and can be operated without carrying cookies.
 */
async function defaultPersist(opts: { accountId: string; proxySessionId: string; country?: string; cookies: any[] }): Promise<void> {
  const session = await openAuthenticatedSession({
    accountId: opts.accountId,
    proxySessionId: opts.proxySessionId,
    country: opts.country,
    cookies: opts.cookies,
    persistentProfile: true,
    pool: "connect", // don't borrow an op slot for a slow seed
  });
  try {
    await session.page.goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await session.page.waitForTimeout(3000); // let Chrome flush the injected cookies to the profile
  } finally {
    await session.close();
  }
}

function defaultDeps(): SeedDeps {
  return { login: (req) => loginTikTok(req), persist: defaultPersist };
}

/**
 * Register a fresh pool row and hand back its id immediately, so the route can
 * 202 before the slow, browser-driven login runs. The row starts 'connecting'
 * (not leasable) and only `runSeed` flips it to 'active'.
 */
export function beginSeed(input: SeedCredentialsInput): SeedStartResult {
  const id = randomUUID().replace(/-/g, "");
  const proxySessionId = id; // the hex id doubles as the sticky IPRoyal session key
  const reg = registerPoolAccount({ id, country: input.country, proxySessionId, tag: input.tag });
  if (!reg.ok) throw new Error(reg.error);
  return { account_id: id, proxy_session_id: proxySessionId, status: "connecting" };
}

/**
 * Do the actual seeding for an already-registered row: log in through the pinned
 * proxy, persist the session into the profile, mark 'active'. Every failure path
 * lands the row in 'dead' with a code so it can never be leased and the operator
 * can see why. Safe to run in the background (setImmediate) after the 202.
 */
export async function runSeed(
  args: { account_id: string; proxy_session_id: string; country?: string } & ParsedCredential,
  deps: SeedDeps = defaultDeps(),
): Promise<SeedOutcome> {
  let loginRes: TikTokLoginResult;
  try {
    loginRes = await deps.login({
      account_id: args.account_id,
      proxy_session_id: args.proxy_session_id,
      country: args.country,
      login: args.login,
      password: args.password,
      email: args.email,
      email_password: args.email_password,
      allowFormLogin: true, // admin-supervised seed is the sanctioned form-login run
    });
  } catch (e: any) {
    markDead(args.account_id, "LOGIN_THREW");
    return { ok: false, status: "dead", error: e?.message || String(e), error_code: "LOGIN_THREW" };
  }
  if (!loginRes.success) {
    markDead(args.account_id, loginRes.error_code || "LOGIN_FAILED");
    return { ok: false, status: "dead", error: loginRes.error, error_code: loginRes.error_code };
  }
  try {
    await deps.persist({
      accountId: args.account_id,
      proxySessionId: args.proxy_session_id,
      country: args.country,
      cookies: loginRes.cookies || [],
    });
  } catch (e: any) {
    markDead(args.account_id, "PERSIST_FAILED");
    return {
      ok: false,
      status: "dead",
      error: `Login succeeded but persisting the session failed: ${e?.message || e}`,
      error_code: "PERSIST_FAILED",
    };
  }
  if (loginRes.observed_username) {
    try { setHandle(args.account_id, loginRes.observed_username); } catch { /* handle is cosmetic */ }
  }
  markConnected(args.account_id); // active → leasable
  const row = getAccount(args.account_id);
  return { ok: true, status: "active", handle: row?.handle ?? loginRes.observed_username ?? null };
}
