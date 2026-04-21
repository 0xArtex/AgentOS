/**
 * Server-side IMAP email reader. Used by the social-login flow to auto-solve
 * the "Verify it's really you" device-verification codes TikTok (and others)
 * send to an account's bind email.
 *
 * Design:
 *   - Provider-aware: maps common email domains to their IMAP endpoints.
 *     Unknown domains fall through to a heuristic `imap.<domain>` guess.
 *   - Credentials never persist — passed in per call, held only in the
 *     session memory for the duration of the poll.
 *   - Conservative: polls only the last ~5 minutes of mail, stops on the
 *     first matching message so we don't replay old codes.
 */
import { ImapFlow } from "imapflow";

export interface ImapEndpoint {
  host: string;
  port: number;
  secure: boolean;
}

export interface FetchCodeRequest {
  /** Full email address (login on the IMAP server). */
  email: string;
  /** Account password (or provider-specific "app password"). */
  password: string;
  /**
   * Minimum length of the numeric code to return. TikTok uses 6, Twitter
   * used to use 6 too; keep it flexible in case something changes.
   */
  minDigits?: number;
  /** Maximum length of the numeric code. */
  maxDigits?: number;
  /**
   * Optional sender filter. If provided, only messages whose From contains
   * this string (case-insensitive) are considered. Reduces false matches
   * when an inbox gets other mail containing digit sequences.
   */
  fromContains?: string;
  /** How far back to look for the code (ms). Default 5 minutes. */
  lookbackMs?: number;
  /** How long to keep polling before giving up (ms). Default 90s. */
  timeoutMs?: number;
  /** Poll interval between IMAP checks (ms). Default 5s. */
  pollIntervalMs?: number;
  /**
   * Optional explicit IMAP endpoint override. Use when the provider can't
   * be derived from the email domain (custom corporate mail, etc.).
   */
  endpoint?: ImapEndpoint;
}

export interface FetchCodeResult {
  success: boolean;
  code?: string;
  /** Subject of the matched message (for logging/diagnostics). */
  subject?: string;
  /** From address of the matched message. */
  from?: string;
  /** When the match was found. */
  matched_at?: string;
  error?: string;
  error_code?:
    | "PROVIDER_UNKNOWN"
    | "IMAP_AUTH_FAILED"
    | "IMAP_CONNECT_FAILED"
    | "TIMEOUT"
    | "NO_CODE_FOUND"
    | "UNKNOWN";
}

/**
 * IMAP endpoints for common providers. Keys are the domain component of the
 * email address, lowercase. Matches are longest-suffix first so that
 * `user@something.hotmail.com` matches `hotmail.com`.
 */
const PROVIDER_MAP: Record<string, ImapEndpoint> = {
  "hotmail.com":   { host: "outlook.office365.com", port: 993, secure: true },
  "outlook.com":   { host: "outlook.office365.com", port: 993, secure: true },
  "live.com":      { host: "outlook.office365.com", port: 993, secure: true },
  "msn.com":       { host: "outlook.office365.com", port: 993, secure: true },
  "office365.com": { host: "outlook.office365.com", port: 993, secure: true },

  "gmail.com":     { host: "imap.gmail.com",        port: 993, secure: true },
  "googlemail.com":{ host: "imap.gmail.com",        port: 993, secure: true },

  "yahoo.com":     { host: "imap.mail.yahoo.com",   port: 993, secure: true },
  "yahoo.co.uk":   { host: "imap.mail.yahoo.com",   port: 993, secure: true },
  "ymail.com":     { host: "imap.mail.yahoo.com",   port: 993, secure: true },

  "icloud.com":    { host: "imap.mail.me.com",      port: 993, secure: true },
  "me.com":        { host: "imap.mail.me.com",      port: 993, secure: true },

  "rambler.ru":    { host: "imap.rambler.ru",       port: 993, secure: true },
  "mail.ru":       { host: "imap.mail.ru",          port: 993, secure: true },
  "inbox.ru":      { host: "imap.mail.ru",          port: 993, secure: true },
  "bk.ru":         { host: "imap.mail.ru",          port: 993, secure: true },
  "list.ru":       { host: "imap.mail.ru",          port: 993, secure: true },
  "yandex.ru":     { host: "imap.yandex.ru",        port: 993, secure: true },
  "yandex.com":    { host: "imap.yandex.com",       port: 993, secure: true },

  "proton.me":     { host: "127.0.0.1",             port: 1143, secure: false }, // requires Bridge — flag as unsupported
  "protonmail.com":{ host: "127.0.0.1",             port: 1143, secure: false },

  "zoho.com":      { host: "imap.zoho.com",         port: 993, secure: true },
  "gmx.com":       { host: "imap.gmx.com",          port: 993, secure: true },
  "gmx.net":       { host: "imap.gmx.net",          port: 993, secure: true },
};

/** Which auth method a provider currently supports server-side. */
export type ProviderAuth = "password" | "oauth2-required" | "app-password-required" | "unsupported";

/**
 * Per-domain auth support. Determines whether an account with this email
 * will work with our current (password-based) IMAP client. Callers use this
 * at import time to warn or block unsupported providers up front — stops
 * agents paying for marketplace accounts that can't be automated.
 */
export function providerAuthSupport(email: string): { provider: string; support: ProviderAuth; reason?: string } {
  const at = email.lastIndexOf("@");
  if (at === -1) return { provider: "unknown", support: "unsupported", reason: "Invalid email format" };
  const domain = email.slice(at + 1).toLowerCase().trim();

  // Microsoft consumer & work domains — OAuth2 required since late 2022.
  if (/^(hotmail|outlook|live|msn)\.com$/.test(domain) || /\.onmicrosoft\.com$/.test(domain) || domain === "office365.com") {
    return {
      provider: "microsoft",
      support: "oauth2-required",
      reason: "Microsoft disabled password IMAP for consumer accounts in late 2022. OAuth2 integration isn't wired yet — see internal/ROADMAP_MICROSOFT_OAUTH.md.",
    };
  }

  // Gmail — requires an app-password (16 lowercase chars) not the account password.
  if (/^(gmail|googlemail)\.com$/.test(domain)) {
    return {
      provider: "google",
      support: "app-password-required",
      reason: "Gmail needs a 16-char app-password for IMAP (not the regular account password). Marketplace Gmail accounts rarely ship with one.",
    };
  }

  // Yahoo — also requires app-password for most accounts since 2022.
  if (/^(yahoo|ymail)\./.test(domain)) {
    return {
      provider: "yahoo",
      support: "app-password-required",
      reason: "Yahoo needs an app-password for IMAP. Buy accounts with rambler.ru / mail.ru if you want password-based auth.",
    };
  }

  // ProtonMail — IMAP only via local Bridge, not usable server-side.
  if (/^(proton|protonmail)\./.test(domain)) {
    return {
      provider: "proton",
      support: "unsupported",
      reason: "ProtonMail IMAP requires a local Bridge running alongside the user's client — not available server-side.",
    };
  }

  // Known-good: password IMAP works out of the box.
  if (/^(rambler|mail|inbox|bk|list|yandex)\.(ru|com)$/.test(domain) ||
      /^icloud\.com$/.test(domain) || /^me\.com$/.test(domain) ||
      /^(zoho|gmx)\.(com|net)$/.test(domain)) {
    return { provider: domain, support: "password" };
  }

  // Unknown domain — we'll try `imap.<domain>:993` as a heuristic but warn.
  return {
    provider: domain,
    support: "password",
    reason: `Unknown provider. Will try imap.${domain}:993 — may fail if that endpoint doesn't exist.`,
  };
}

/** Human-readable list of providers that work with today's CLI. */
export const SUPPORTED_EMAIL_PROVIDERS = [
  "rambler.ru", "mail.ru", "inbox.ru", "bk.ru", "list.ru",
  "yandex.ru", "yandex.com",
  "icloud.com", "me.com",
  "zoho.com", "gmx.com", "gmx.net",
];

function resolveEndpoint(email: string, override?: ImapEndpoint): ImapEndpoint | null {
  if (override) return override;
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = email.slice(at + 1).toLowerCase().trim();

  // Exact match first, then longest-suffix match.
  if (PROVIDER_MAP[domain]) return PROVIDER_MAP[domain];
  const suffixes = Object.keys(PROVIDER_MAP).sort((a, b) => b.length - a.length);
  for (const s of suffixes) {
    if (domain.endsWith("." + s)) return PROVIDER_MAP[s];
  }

  // Heuristic fallback for unknown domains. Tries `imap.<domain>` which
  // works for most properly-configured custom mail servers.
  return { host: `imap.${domain}`, port: 993, secure: true };
}

/**
 * Open an IMAP connection, scan INBOX (and sometimes Junk) for a recent
 * message matching the filter, and return a numeric code extracted from it.
 */
export async function fetchVerificationCode(req: FetchCodeRequest): Promise<FetchCodeResult> {
  const minDigits = req.minDigits ?? 4;
  const maxDigits = req.maxDigits ?? 8;
  const lookbackMs = req.lookbackMs ?? 5 * 60 * 1000;
  // Default 3 minutes — TikTok verification emails usually arrive in 10-60s
  // but Russian providers (rambler, mail.ru) can take up to 2 minutes on
  // spike hours. Callers can pass `timeoutMs` to override.
  const timeoutMs = req.timeoutMs ?? 180 * 1000;
  const pollIntervalMs = req.pollIntervalMs ?? 5 * 1000;
  // How many times to retry a transient IMAP connect failure before giving up.
  const connectRetries = 3;

  const endpoint = resolveEndpoint(req.email, req.endpoint);
  if (!endpoint) {
    return { success: false, error: `Could not resolve IMAP endpoint for ${req.email}`, error_code: "PROVIDER_UNKNOWN" };
  }
  if (endpoint.host === "127.0.0.1") {
    return { success: false, error: `ProtonMail / similar providers require a local Bridge — not supported server-side.`, error_code: "PROVIDER_UNKNOWN" };
  }

  const codeRegex = new RegExp(`\\b(\\d{${minDigits},${maxDigits}})\\b`);

  const client = new ImapFlow({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    auth: { user: req.email, pass: req.password },
    logger: false,
    emitLogs: false,
  });

  try {
    // Retry transient network failures. Auth failures are returned immediately
    // — no point retrying wrong credentials.
    let connected = false;
    let lastErr: any = null;
    for (let attempt = 0; attempt < connectRetries; attempt++) {
      try {
        await client.connect();
        connected = true;
        break;
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message || e);
        const authFailed = /AUTH|authenticat|LOGIN|basic auth|disabled|invalid credentials/i.test(msg);
        if (authFailed) break;          // don't retry auth failures
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    if (!connected) {
      const msg = String(lastErr?.message || lastErr);
      const authFailed = /AUTH|authenticat|LOGIN|basic auth|disabled|invalid credentials/i.test(msg);

      // Microsoft disabled basic IMAP auth for consumer hotmail/outlook/live
      // accounts in late 2022. Surface this specifically so the user knows
      // to buy accounts from a supported provider.
      if (endpoint.host.includes("outlook.office365.com")) {
        return {
          success: false,
          error: `Microsoft disabled basic IMAP auth for consumer accounts (hotmail/outlook/live) in late 2022. This account needs OAuth2, which isn't wired yet. Recommendation: buy accounts with rambler.ru, mail.ru, or yandex.ru email — those use password auth.`,
          error_code: "IMAP_AUTH_FAILED",
        };
      }

      return {
        success: false,
        error: `IMAP ${authFailed ? "auth" : "connect"} to ${endpoint.host}:${endpoint.port} failed after ${connectRetries} attempts: ${msg}`,
        error_code: authFailed ? "IMAP_AUTH_FAILED" : "IMAP_CONNECT_FAILED",
      };
    }

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const hit = await scanOnce(client, {
        sinceMs: Date.now() - lookbackMs,
        fromContains: req.fromContains,
        codeRegex,
      });
      if (hit) return { success: true, ...hit, matched_at: new Date().toISOString() };
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    return {
      success: false,
      error: `No matching verification email arrived within ${timeoutMs / 1000}s`,
      error_code: "TIMEOUT",
    };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e), error_code: "UNKNOWN" };
  } finally {
    try { await client.logout(); } catch {}
  }
}

/**
 * Scan INBOX (and Junk/Spam as a fallback) for a message matching the
 * filter, return the extracted code if found. Returns null otherwise.
 */
async function scanOnce(
  client: ImapFlow,
  opts: { sinceMs: number; fromContains?: string; codeRegex: RegExp }
): Promise<{ code: string; subject?: string; from?: string } | null> {
  const folders = ["INBOX", "Junk", "Junk Email", "Spam", "[Gmail]/Spam"];

  for (const folder of folders) {
    let lock;
    try {
      lock = await client.getMailboxLock(folder);
    } catch {
      continue; // folder doesn't exist on this provider
    }

    try {
      const since = new Date(opts.sinceMs);
      const search = await client.search({ since });
      if (!search || search.length === 0) continue;

      // Newest first — avoid returning stale codes if an older message happens
      // to match the filter.
      const ordered = [...search].sort((a, b) => Number(b) - Number(a));

      for (const seq of ordered) {
        const message = await client.fetchOne(seq, {
          envelope: true,
          source: true,
          bodyStructure: true,
        });
        if (!message) continue;

        const env: any = message.envelope;
        const from = (env?.from?.[0]?.address as string) || "";
        if (opts.fromContains && !from.toLowerCase().includes(opts.fromContains.toLowerCase())) continue;

        const subject = (env?.subject as string) || "";
        const rawSource = message.source?.toString("utf8") || "";
        // Decode quoted-printable / base64 lazily — most verify emails are
        // plain text, and if not, the digits are usually also in headers /
        // subject or the fallback HTML text content.
        const bodyText = rawSource.replace(/=\r\n/g, "").replace(/=[0-9A-F]{2}/g, (m: string) =>
          String.fromCharCode(parseInt(m.slice(1), 16))
        );
        const haystack = subject + "\n" + bodyText;

        const m = opts.codeRegex.exec(haystack);
        if (m && m[1]) {
          return { code: m[1], subject, from };
        }
      }
    } finally {
      lock.release();
    }
  }

  return null;
}
