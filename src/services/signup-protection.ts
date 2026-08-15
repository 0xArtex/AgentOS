import { createHash, randomBytes, randomUUID } from "crypto";
import { db } from "../db";
import { config } from "../config";
import { sendEmailViaMailgun } from "./mailgun";

const VERIFY_TTL_MINUTES = 30;
const RESEND_COOLDOWN_SECONDS = 60;
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileResult =
  | { ok: true }
  | { ok: false; unavailable: boolean; reason: string };

interface TurnstileResponse {
  success?: boolean;
  action?: string;
  hostname?: string;
  "error-codes"?: string[];
}

export interface PendingRegistration {
  email: string;
  display_name: string;
  password_hash: string;
  continue_path: string;
  expires_at: string;
  last_sent_at: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeContinuePath(value: unknown): "/dashboard.html" | "/socials" {
  return value === "/socials" ? "/socials" : "/dashboard.html";
}

export function turnstileSiteKey(): string {
  return process.env.TURNSTILE_SITE_KEY || "";
}

export function signupProtectionConfigured(): boolean {
  if (process.env.NODE_ENV !== "production" && process.env.TURNSTILE_BYPASS === "1") return true;
  return !!(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
}

export async function verifyTurnstile(token: unknown, remoteIp: string): Promise<TurnstileResult> {
  if (process.env.NODE_ENV !== "production" && process.env.TURNSTILE_BYPASS === "1") {
    return { ok: true };
  }

  const secret = process.env.TURNSTILE_SECRET_KEY || "";
  if (!secret || !process.env.TURNSTILE_SITE_KEY) {
    return { ok: false, unavailable: true, reason: "turnstile_not_configured" };
  }
  if (typeof token !== "string" || token.length < 10 || token.length > 4096) {
    return { ok: false, unavailable: false, reason: "missing_or_invalid_token" };
  }

  const form = new URLSearchParams({
    secret,
    response: token,
    remoteip: remoteIp,
    idempotency_key: randomUUID(),
  });

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return { ok: false, unavailable: true, reason: `siteverify_http_${response.status}` };
    }
    const result = await response.json() as TurnstileResponse;
    if (!result.success) {
      return { ok: false, unavailable: false, reason: (result["error-codes"] || ["challenge_failed"]).join(",") };
    }
    if (result.action !== "register") {
      return { ok: false, unavailable: false, reason: "action_mismatch" };
    }
    const expectedHostname = (process.env.TURNSTILE_EXPECTED_HOSTNAME || "").trim().toLowerCase();
    if (expectedHostname && String(result.hostname || "").toLowerCase() !== expectedHostname) {
      return { ok: false, unavailable: false, reason: "hostname_mismatch" };
    }
    return { ok: true };
  } catch (error: any) {
    return { ok: false, unavailable: true, reason: error?.name === "TimeoutError" ? "siteverify_timeout" : "siteverify_unavailable" };
  }
}

function verificationToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: sha256(raw) };
}

function publicBaseUrl(): string {
  const configured = (process.env.PALMYR_API_BASE || "https://palmyr.ai").replace(/\/+$/, "");
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
    return url.origin;
  } catch {
    return "https://palmyr.ai";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] || char);
}

async function sendVerificationEmail(email: string, displayName: string, rawToken: string, continuePath: string): Promise<void> {
  const verifyUrl = new URL("/auth/verify-email", publicBaseUrl());
  verifyUrl.searchParams.set("token", rawToken);
  verifyUrl.searchParams.set("next", normalizeContinuePath(continuePath));
  const link = verifyUrl.toString();
  const safeName = escapeHtml(displayName || "there");
  const safeLink = escapeHtml(link);
  // mailgun.ts derives the sending domain with a simple split('@'), so keep
  // this as a bare address rather than an RFC 5322 display-name wrapper.
  const from = process.env.EMAIL_FROM || `noreply@${config.emailDomain}`;

  await sendEmailViaMailgun({
    from,
    to: email,
    subject: "Verify your Palmyr email",
    body: `Hi ${displayName || "there"},\n\nVerify your email to activate your Palmyr account:\n${link}\n\nThis link expires in ${VERIFY_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.`,
    html: `<!doctype html><html><body style="margin:0;background:#112d32;color:#f7ead1;font-family:Arial,sans-serif"><div style="max-width:520px;margin:0 auto;padding:48px 24px"><div style="font-size:20px;font-weight:700;color:#F6AF56;margin-bottom:28px">PALMYR</div><h1 style="font-size:26px;margin:0 0 14px">Verify your email</h1><p style="color:rgba(247,234,209,.72);line-height:1.6">Hi ${safeName}, click below to activate your account.</p><p style="margin:28px 0"><a href="${safeLink}" style="display:inline-block;background:#F6AF56;color:#112d32;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">Verify email</a></p><p style="font-size:13px;color:rgba(247,234,209,.48);line-height:1.6">This link expires in ${VERIFY_TTL_MINUTES} minutes. If you did not request this account, ignore this email.</p></div></body></html>`,
  });
}

export async function createPendingRegistration(input: {
  email: string;
  passwordHash: string;
  displayName: string;
  continuePath: string;
}): Promise<void> {
  const token = verificationToken();
  const continuePath = normalizeContinuePath(input.continuePath);
  db.prepare(`
    INSERT INTO dashboard_pending_registrations
      (email, password_hash, display_name, token_hash, continue_path, expires_at, created_at, last_sent_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', '+${VERIFY_TTL_MINUTES} minutes'), datetime('now', 'utc'), datetime('now', 'utc'))
    ON CONFLICT(email) DO UPDATE SET
      password_hash = excluded.password_hash,
      display_name = excluded.display_name,
      token_hash = excluded.token_hash,
      continue_path = excluded.continue_path,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at,
      last_sent_at = excluded.last_sent_at
  `).run(input.email, input.passwordHash, input.displayName, token.hash, continuePath);

  await sendVerificationEmail(input.email, input.displayName, token.raw, continuePath);
}

export async function resendPendingRegistration(email: string, continuePath: string): Promise<"sent" | "cooldown" | "missing"> {
  const pending = db.prepare(`
    SELECT email, display_name, password_hash, continue_path, expires_at, last_sent_at
    FROM dashboard_pending_registrations
    WHERE email = ? AND expires_at > datetime('now')
  `).get(email) as PendingRegistration | undefined;
  if (!pending) return "missing";

  const tooSoon = db.prepare(`
    SELECT 1 AS yes FROM dashboard_pending_registrations
    WHERE email = ? AND last_sent_at > datetime('now', '-${RESEND_COOLDOWN_SECONDS} seconds')
  `).get(email);
  if (tooSoon) return "cooldown";

  const token = verificationToken();
  const next = normalizeContinuePath(continuePath || pending.continue_path);
  db.prepare(`
    UPDATE dashboard_pending_registrations
    SET token_hash = ?, continue_path = ?, expires_at = datetime('now', '+${VERIFY_TTL_MINUTES} minutes'), last_sent_at = datetime('now', 'utc')
    WHERE email = ?
  `).run(token.hash, next, email);
  await sendVerificationEmail(email, pending.display_name, token.raw, next);
  return "sent";
}

export function consumePendingRegistration(rawToken: unknown): { ok: true; email: string; continuePath: string } | { ok: false; reason: "invalid" | "expired" } {
  if (typeof rawToken !== "string" || !/^[a-f0-9]{64}$/i.test(rawToken)) return { ok: false, reason: "invalid" };
  const hash = sha256(rawToken.toLowerCase());

  const consume = db.transaction(() => {
    const pending = db.prepare(`
      SELECT email, password_hash, display_name, continue_path, expires_at,
             CASE WHEN expires_at > datetime('now') THEN 1 ELSE 0 END AS fresh
      FROM dashboard_pending_registrations WHERE token_hash = ?
    `).get(hash) as (PendingRegistration & { fresh: number }) | undefined;
    if (!pending) return { ok: false as const, reason: "invalid" as const };
    if (!pending.fresh) {
      db.prepare("DELETE FROM dashboard_pending_registrations WHERE token_hash = ?").run(hash);
      return { ok: false as const, reason: "expired" as const };
    }

    const existing = db.prepare("SELECT id FROM dashboard_users WHERE email = ?").get(pending.email);
    if (!existing) {
      db.prepare(`
        INSERT INTO dashboard_users (id, email, password_hash, display_name, email_verified_at)
        VALUES (?, ?, ?, ?, datetime('now', 'utc'))
      `).run(randomUUID(), pending.email, pending.password_hash, pending.display_name);
    }
    db.prepare("DELETE FROM dashboard_pending_registrations WHERE email = ?").run(pending.email);
    return { ok: true as const, email: pending.email, continuePath: normalizeContinuePath(pending.continue_path) };
  });

  return consume();
}

export function cleanupExpiredPendingRegistrations(): void {
  db.prepare("DELETE FROM dashboard_pending_registrations WHERE expires_at <= datetime('now')").run();
}
