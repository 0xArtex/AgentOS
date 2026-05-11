/**
 * Mailgun integration. Email backend for both outbound sending and per-domain
 * DKIM provisioning when a wallet creates an inbox on a domain it owns.
 *
 * Why Mailgun (over SES, Resend, Postmark): Foundation plan supports up to
 * 1,000 verified custom sending domains for $35/mo, with a 30-day trial that
 * unlocks full features at $0. Resend caps domains aggressively; SES T&S
 * rejected our production-access request without specifics; Postmark is
 * transactional-only with hard limits on sender domains.
 *
 * One-time prereqs (manual, ~5 min — no sandbox-exit application required):
 *   1. Sign up at https://www.mailgun.com — 30-day trial unlocks Foundation
 *      features ($0 for first month, no domain caps to worry about).
 *   2. Mailgun → Settings → API Keys → copy a "Private API key".
 *   3. Mailgun → Sending → Webhooks → "HTTP webhook signing key".
 *   4. Set in prod `.env`:
 *        MAILGUN_API_KEY=...                  (private API key)
 *        MAILGUN_REGION=us|eu                 (default us; matches the region
 *                                              you signed up in — visible in
 *                                              the dashboard URL)
 *        MAILGUN_WEBHOOK_SIGNING_KEY=...      (for /email/inbound HMAC verify)
 *   5. Restart prod server. provision_email_inbox on a custom domain now
 *      auto-registers as a Mailgun sending domain, gets back DKIM + SPF
 *      records, and writes them via Namecheap. Mailgun auto-verifies within
 *      a few minutes of DNS propagation.
 *
 * No "request production access" step. Reactive abuse review can still
 * suspend an account that looks ESP-resellerish, so the operational
 * advice is: warm palmyr.ai with real transactional traffic for a week
 * before adding many user domains.
 */

import type { DnsHostRecord } from './namecheap';

const API_BASES = {
  us: 'https://api.mailgun.net',
  eu: 'https://api.eu.mailgun.net',
} as const;

function apiBase(): string {
  const region = (process.env.MAILGUN_REGION || 'us').toLowerCase();
  return API_BASES[region as keyof typeof API_BASES] ?? API_BASES.us;
}

function authHeader(): string {
  const key = process.env.MAILGUN_API_KEY || '';
  return 'Basic ' + Buffer.from('api:' + key).toString('base64');
}

async function mgFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = apiBase() + path;
  const headers: Record<string, string> = {
    Authorization: authHeader(),
    Accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  return fetch(url, { ...init, headers });
}

async function mgJson<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await mgFetch(path, init);
  const text = await resp.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Mailgun ${path} non-JSON response (${resp.status}): ${text.slice(0, 200)}`);
  }
  if (!resp.ok) {
    const msg = parsed?.message || parsed?.error || text || `HTTP ${resp.status}`;
    const err: any = new Error(`Mailgun ${path} failed (${resp.status}): ${msg}`);
    err.status = resp.status;
    err.body = parsed;
    throw err;
  }
  return parsed as T;
}

export function isMailgunConfigured(): boolean {
  return !!process.env.MAILGUN_API_KEY;
}

export interface MailgunSendInput {
  from: string;
  to: string | string[];
  subject: string;
  body: string;
  html?: string;
  replyTo?: string;
}

/**
 * Send a message through Mailgun's sending API. The from-address's domain
 * must already be verified (call registerDomainWithMailgun first, then wait
 * for DNS propagation).
 */
export async function sendEmailViaMailgun(input: MailgunSendInput): Promise<{ id: string }> {
  if (!isMailgunConfigured()) {
    throw new Error('MAILGUN_API_KEY not set');
  }
  const fromDomain = input.from.split('@')[1];
  if (!fromDomain) throw new Error(`Invalid from address: ${input.from}`);

  const form = new URLSearchParams();
  form.set('from', input.from);
  for (const addr of Array.isArray(input.to) ? input.to : [input.to]) {
    form.append('to', addr);
  }
  form.set('subject', input.subject);
  form.set('text', input.body);
  if (input.html) form.set('html', input.html);
  if (input.replyTo) form.set('h:Reply-To', input.replyTo);

  const resp = await mgJson<{ id?: string; message?: string }>(
    `/v3/${encodeURIComponent(fromDomain)}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    },
  );
  if (!resp.id) throw new Error(`Mailgun send returned no id: ${resp.message ?? 'unknown'}`);
  return { id: resp.id.replace(/^<|>$/g, '') };
}

/**
 * Register a domain with Mailgun (or look it up if already there) and return
 * the DKIM + SPF records that need to be set on the user's DNS so Mailgun
 * will verify it.
 *
 * Idempotent: if the domain already exists (Mailgun returns 400 with
 * "domain already exists"), falls through to GET for the same shape.
 */
export async function registerDomainWithMailgun(
  domain: string,
): Promise<{ id: string; status: string; records: DnsHostRecord[] }> {
  if (!isMailgunConfigured()) {
    throw new Error('MAILGUN_API_KEY not set');
  }

  // Try create first. If it already exists, fall through to GET.
  try {
    const form = new URLSearchParams();
    form.set('name', domain);
    form.set('dkim_key_size', '2048');
    const created = await mgJson<MailgunDomainResponse>('/v4/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    return shapeDomainResponse(domain, created);
  } catch (err: any) {
    const msg = String(err?.body?.message || err?.message || '');
    const alreadyExists = err?.status === 400 && /already.*exist/i.test(msg);
    if (!alreadyExists) throw err;
  }

  const got = await mgJson<MailgunDomainResponse>(
    `/v4/domains/${encodeURIComponent(domain)}`,
  );
  return shapeDomainResponse(domain, got);
}

/**
 * Fetch the verification status of a domain that's already been registered
 * with Mailgun. Used by `GET /email/domains/:domain/status` so callers can
 * poll for verification without re-running provision.
 *
 * If `forceRecheck` is true (default), we PUT to the verify endpoint first
 * so Mailgun re-polls DNS *now* instead of returning stale cached state.
 * Without this, Mailgun's background poller can take several minutes to
 * notice a freshly-written DKIM/SPF/MX record, which makes `palmyr email
 * status` return "pending" long after DNS has propagated.
 */
export async function getMailgunDomainStatus(
  domain: string,
  forceRecheck: boolean = true,
): Promise<{ found: boolean; id?: string; status?: string; records?: DnsHostRecord[] }> {
  if (!isMailgunConfigured()) {
    throw new Error('MAILGUN_API_KEY not set');
  }
  if (forceRecheck) {
    // Same call the "Check status" button in the dashboard makes. Errors are
    // non-fatal here — fall through to GET so callers still see cached state.
    try {
      await mgFetch(`/v4/domains/${encodeURIComponent(domain)}/verify`, { method: 'PUT' });
    } catch { /* best effort */ }
  }
  try {
    const got = await mgJson<MailgunDomainResponse>(
      `/v4/domains/${encodeURIComponent(domain)}`,
    );
    const shaped = shapeDomainResponse(domain, got);
    return { found: true, ...shaped };
  } catch (err: any) {
    if (err?.status === 404) return { found: false };
    throw err;
  }
}

/**
 * Force Mailgun to re-poll DNS for a domain. Same call as the dashboard's
 * "Check status" button. Use after writing DKIM/SPF/MX records so the
 * provision response reflects truth instead of Mailgun's stale cache.
 */
export async function forceVerifyMailgunDomain(
  domain: string,
): Promise<{ status: string; records: DnsHostRecord[] }> {
  if (!isMailgunConfigured()) {
    throw new Error('MAILGUN_API_KEY not set');
  }
  const verified = await mgJson<MailgunDomainResponse>(
    `/v4/domains/${encodeURIComponent(domain)}/verify`,
    { method: 'PUT' },
  );
  const shaped = shapeDomainResponse(domain, verified);
  return { status: shaped.status, records: shaped.records };
}

/**
 * Verify a Mailgun inbound webhook signature. Mailgun signs every webhook
 * POST with HMAC-SHA256(timestamp + token, signing_key). Reject anything
 * that doesn't match — otherwise an attacker who finds the public webhook
 * URL can inject inbound mail into arbitrary inboxes.
 *
 * Also reject timestamps older than 5 minutes to prevent replay.
 */
export function verifyMailgunWebhook(
  timestamp: string | undefined,
  token: string | undefined,
  signature: string | undefined,
): boolean {
  if (!timestamp || !token || !signature) return false;
  const key = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  if (!key) return false;

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  // Mailgun timestamps are seconds since epoch.
  const ageSeconds = Math.abs(Date.now() / 1000 - ts);
  if (ageSeconds > 5 * 60) return false;

  const { createHmac, timingSafeEqual } = require('crypto') as typeof import('crypto');
  const expected = createHmac('sha256', key).update(timestamp + token).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── Internal helpers ───────────────────────────────────────────────

interface MailgunDnsRecord {
  record_type?: string;
  name?: string;
  value?: string;
  valid?: string;            // 'valid' | 'unknown' | 'invalid'
  cached?: string[];
  is_active?: boolean;
}

interface MailgunDomainResponse {
  domain?: {
    name?: string;
    state?: string;          // 'active' | 'unverified' | 'disabled'
    type?: string;
  };
  sending_dns_records?: MailgunDnsRecord[];
  receiving_dns_records?: MailgunDnsRecord[];
  message?: string;
}

function shapeDomainResponse(
  domain: string,
  resp: MailgunDomainResponse,
): { id: string; status: string; records: DnsHostRecord[] } {
  const sending = (resp.sending_dns_records || [])
    .map(rec => toHostRecord(rec, domain))
    .filter(Boolean) as DnsHostRecord[];
  // Mailgun's sending_dns_records covers DKIM + SPF. Inbound MX is added by
  // the route layer (always sets mxa/mxb.mailgun.org so receive lands somewhere).
  return {
    id: resp.domain?.name || domain,
    status: mapMailgunState(resp.domain?.state, sending),
    records: sending,
  };
}

/**
 * Convert a Mailgun DNS record to Palmyr's DnsHostRecord shape (Namecheap-
 * compatible). Mailgun returns the host as an FQDN (e.g.
 * `mta._domainkey.example.com`); Namecheap wants the bare host
 * (`mta._domainkey`), so we strip the domain suffix.
 */
function toHostRecord(rec: MailgunDnsRecord, domain: string): DnsHostRecord | null {
  if (!rec.record_type || !rec.value) return null;
  const type = rec.record_type.toUpperCase();
  const fqdn = (rec.name || domain).toLowerCase().replace(/\.$/, '');
  const apex = domain.toLowerCase().replace(/\.$/, '');
  let name: string;
  if (fqdn === apex) {
    name = '@';
  } else if (fqdn.endsWith('.' + apex)) {
    name = fqdn.slice(0, fqdn.length - apex.length - 1);
  } else {
    name = fqdn;
  }
  return {
    type: type as DnsHostRecord['type'],
    name,
    value: rec.value,
    ttl: 1800,
  };
}

function mapMailgunState(state: string | undefined, records: DnsHostRecord[]): string {
  // Normalize to the same vocab the SES route used so callers don't break:
  //   'verified' | 'pending' | 'failed' | 'unknown'
  if (!state) return records.length > 0 ? 'pending' : 'unknown';
  const s = state.toLowerCase();
  if (s === 'active') return 'verified';
  if (s === 'unverified') return 'pending';
  if (s === 'disabled') return 'failed';
  return s;
}
