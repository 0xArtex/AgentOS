/**
 * Resend integration. Used as the email backend for both outbound sending
 * and per-domain DKIM provisioning when a user creates an inbox on a domain
 * they own.
 *
 * One-time prereqs (manual, ~5 min):
 *   1. Sign up at resend.com → API Keys → create one with full access.
 *   2. Set RESEND_API_KEY in prod .env.
 *   3. In the Resend dashboard, add the EMAIL_DOMAIN value (defaults to
 *      `agntos.dev`) and set the DNS records it asks for. This unlocks the
 *      default-domain inbox flow (hello@agntos.dev).
 *
 * Per-user-domain flow is automated: when a wallet provisions an inbox on a
 * Namecheap-registered domain, the route calls `registerDomainWithResend()`
 * which calls Resend's Domains API and returns the DNS records to set via
 * Namecheap. Resend auto-verifies once DNS propagates (typically 5-30 min).
 */

import { Resend } from 'resend';
import type { DnsHostRecord } from './namecheap';

let _client: Resend | null = null;

function client(): Resend {
  if (_client) return _client;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY not configured — email send/domain registration unavailable');
  }
  _client = new Resend(apiKey);
  return _client;
}

export function isResendConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

/**
 * Fetch the verification status of a domain that's already been registered
 * with Resend. Used by `GET /email/domains/:domain/status` so callers can
 * poll for verification without spawning a new inbox provision.
 */
export async function getResendDomainStatus(
  domain: string
): Promise<{ found: boolean; id?: string; status?: string; records?: DnsHostRecord[] }> {
  const r = client();
  const list = await r.domains.list();
  if (list.error || !list.data) return { found: false };
  const data = (list.data as any).data ?? list.data;
  if (!Array.isArray(data)) return { found: false };
  const match = data.find((d: any) => d.name === domain);
  if (!match) return { found: false };
  const detail = await r.domains.get(match.id);
  if (detail.error || !detail.data) return { found: true, id: match.id, status: 'unknown' };
  const detailData = detail.data as any;
  return {
    found: true,
    id: match.id,
    status: detailData.status ?? 'unknown',
    records: mapResendRecords(detailData.records ?? []),
  };
}

export interface ResendSendInput {
  from: string;
  to: string | string[];
  subject: string;
  body: string;
  html?: string;
  replyTo?: string;
}

export async function sendEmailViaResend(input: ResendSendInput): Promise<{ id: string }> {
  const r = client();
  const result = await r.emails.send({
    from: input.from,
    to: Array.isArray(input.to) ? input.to : [input.to],
    subject: input.subject,
    text: input.body,
    html: input.html,
    replyTo: input.replyTo,
  });
  if (result.error) {
    throw new Error(`Resend send failed: ${result.error.message ?? JSON.stringify(result.error)}`);
  }
  if (!result.data?.id) throw new Error('Resend returned no message id');
  return { id: result.data.id };
}

/**
 * Register a domain with Resend (or look it up if already there) and return
 * the DNS records that need to be set so Resend will verify it.
 *
 * Idempotent: calling on an already-registered domain returns the existing
 * record set without erroring.
 */
export async function registerDomainWithResend(
  domain: string
): Promise<{ id: string; status: string; records: DnsHostRecord[] }> {
  const r = client();

  // Check if already registered.
  const existing = await r.domains.list();
  if (!existing.error && existing.data) {
    const list = (existing.data as any).data ?? existing.data;
    if (Array.isArray(list)) {
      const match = list.find((d: any) => d.name === domain);
      if (match) {
        const detail = await r.domains.get(match.id);
        if (!detail.error && detail.data) {
          return {
            id: match.id,
            status: (detail.data as any).status ?? 'pending',
            records: mapResendRecords((detail.data as any).records ?? []),
          };
        }
      }
    }
  }

  // Otherwise create.
  const created = await r.domains.create({ name: domain });
  if (created.error || !created.data) {
    throw new Error(`Resend domain create failed for ${domain}: ${created.error?.message ?? 'unknown'}`);
  }
  const data = created.data as any;
  return {
    id: data.id,
    status: data.status ?? 'pending',
    records: mapResendRecords(data.records ?? []),
  };
}

/**
 * Convert Resend's record shape into our Namecheap-compatible DnsHostRecord.
 *
 * Resend records look like:
 *   { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10, ttl: 'Auto' }
 *   { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', ttl: 'Auto' }
 *   { record: 'DKIM', name: 'resend._domainkey', type: 'CNAME', value: 'resend._domainkey.<...>.dkim.amazonses.com', ttl: 'Auto' }
 *
 * Namecheap uses relative host names ('@' for apex, 'send' for send.<domain>),
 * not FQDNs — Resend's `name` field already matches that convention.
 */
function mapResendRecords(records: any[]): DnsHostRecord[] {
  return records.map((r: any) => {
    const type = String(r.type || r.record_type || '').toUpperCase() as DnsHostRecord['type'];
    const out: DnsHostRecord = {
      type,
      name: r.name || '@',
      value: r.value,
      ttl: typeof r.ttl === 'number' ? r.ttl : 1800,
    };
    if (type === 'MX' && typeof r.priority === 'number') out.mxPref = r.priority;
    return out;
  });
}
