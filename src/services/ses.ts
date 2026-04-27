/**
 * AWS SES integration. Email backend for both outbound sending and per-domain
 * DKIM provisioning when a wallet creates an inbox on a domain it owns.
 *
 * Why SES (over Resend, Postmark, etc.): scales to thousands of customer
 * domains at near-zero cost. SES has a soft cap of 10,000 verified domain
 * identities per AWS account (raisable on request) and bills $0.10 per 1,000
 * emails sent, vs Resend Enterprise pricing in the hundreds-to-thousands
 * /month for similar domain counts.
 *
 * One-time prereqs (manual, ~10 min + 24h sandbox-exit wait):
 *   1. AWS account with an IAM user that has `AmazonSESFullAccess` (or a
 *      narrower policy: ses:CreateEmailIdentity, ses:GetEmailIdentity,
 *      ses:ListEmailIdentities, ses:SendEmail).
 *   2. Set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` in prod
 *      `.env`. Default region: us-east-1.
 *   3. Verify EMAIL_DOMAIN (defaults to `agntos.dev`) in the SES console
 *      OR call `registerDomainWithSes("agntos.dev")` once and set the DNS
 *      records it returns. Required for the default-domain inbox flow.
 *   4. Request production access to exit SES sandbox mode. While in sandbox,
 *      sending is restricted to addresses you've individually verified.
 *      Approval typically takes 24h; SES asks for use-case context.
 *
 * Per-customer-domain flow is automated: when a wallet provisions an inbox
 * on a Namecheap-registered domain, the route calls `registerDomainWithSes()`
 * which creates the SES identity, gets back DKIM tokens, and converts them
 * to CNAME records that are written via Namecheap. SES auto-verifies once
 * DNS propagates (typically 5-30 min).
 */

import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  ListEmailIdentitiesCommand,
  SendEmailCommand,
} from '@aws-sdk/client-sesv2';
import type { DnsHostRecord } from './namecheap';

let _client: SESv2Client | null = null;

function client(): SESv2Client {
  if (_client) return _client;
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS credentials not configured — set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in env');
  }
  _client = new SESv2Client({
    region: process.env.AWS_REGION || 'us-east-1',
  });
  return _client;
}

export function isSesConfigured(): boolean {
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

export interface SesSendInput {
  from: string;
  to: string | string[];
  subject: string;
  body: string;
  html?: string;
  replyTo?: string;
}

export async function sendEmailViaSes(input: SesSendInput): Promise<{ id: string }> {
  const c = client();
  const resp = await c.send(new SendEmailCommand({
    FromEmailAddress: input.from,
    Destination: {
      ToAddresses: Array.isArray(input.to) ? input.to : [input.to],
    },
    ReplyToAddresses: input.replyTo ? [input.replyTo] : undefined,
    Content: {
      Simple: {
        Subject: { Data: input.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: input.body, Charset: 'UTF-8' },
          ...(input.html ? { Html: { Data: input.html, Charset: 'UTF-8' } } : {}),
        },
      },
    },
  }));
  if (!resp.MessageId) throw new Error('SES SendEmail returned no MessageId');
  return { id: resp.MessageId };
}

/**
 * Register a domain with SES (or look it up if already there) and return
 * the DKIM CNAME records that need to be set so SES will verify it.
 *
 * Idempotent: if the identity already exists (CreateEmailIdentity throws
 * AlreadyExistsException), falls through to GetEmailIdentity and returns
 * the existing record set.
 */
export async function registerDomainWithSes(
  domain: string
): Promise<{ id: string; status: string; records: DnsHostRecord[] }> {
  const c = client();

  // Try create first. If already there, AWS throws AlreadyExistsException —
  // fall through to Get for the same shape.
  try {
    const created = await c.send(new CreateEmailIdentityCommand({
      EmailIdentity: domain,
      // Default behavior: SES auto-generates DKIM keys. No explicit
      // DkimSigningAttributes needed.
    }));
    return {
      id: domain,
      status: mapSesStatus(created.VerifiedForSendingStatus, 'pending'),
      records: dkimTokensToRecords(domain, created.DkimAttributes?.Tokens ?? []),
    };
  } catch (err: any) {
    if (err?.name !== 'AlreadyExistsException') throw err;
  }

  // Already registered — fetch existing.
  const got = await c.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
  return {
    id: domain,
    status: mapSesStatus(got.VerifiedForSendingStatus, 'pending'),
    records: dkimTokensToRecords(domain, got.DkimAttributes?.Tokens ?? []),
  };
}

/**
 * Fetch the verification status of a domain that's already been registered
 * with SES. Used by `GET /email/domains/:domain/status` so callers can poll
 * for verification without re-running provision.
 */
export async function getSesDomainStatus(
  domain: string
): Promise<{ found: boolean; id?: string; status?: string; records?: DnsHostRecord[] }> {
  const c = client();
  try {
    const got = await c.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    return {
      found: true,
      id: domain,
      status: mapSesStatus(got.VerifiedForSendingStatus, 'unknown'),
      records: dkimTokensToRecords(domain, got.DkimAttributes?.Tokens ?? []),
    };
  } catch (err: any) {
    if (err?.name === 'NotFoundException') return { found: false };
    throw err;
  }
}

/**
 * Build the standard SES per-domain DNS record set from the 3 DKIM tokens
 * SES returns when an email identity is created.
 *
 * SES DKIM uses Easy DKIM with 3 selector tokens of the form
 *   <token1>._domainkey.<domain>  CNAME  <token1>.dkim.amazonses.com
 * Plus a sender-domain SPF record at the apex.
 */
function dkimTokensToRecords(domain: string, tokens: string[]): DnsHostRecord[] {
  const records: DnsHostRecord[] = [];
  for (const token of tokens) {
    records.push({
      type: 'CNAME',
      name: `${token}._domainkey`,
      value: `${token}.dkim.amazonses.com`,
      ttl: 1800,
    });
  }
  // Apex SPF authorizing SES to send for this domain. SES is required for
  // DMARC alignment; without it gmail flags as spam.
  records.push({
    type: 'TXT',
    name: '@',
    value: 'v=spf1 include:amazonses.com ~all',
    ttl: 1800,
  });
  return records;
}

function mapSesStatus(raw: boolean | string | undefined, fallback: string): string {
  // SES v2 GetEmailIdentity returns VerifiedForSendingStatus as a boolean
  // (true = verified, false/undefined = pending). Older API surfaces use a
  // string status. Handle both. Normalize to the strings our route already
  // uses: 'verified', 'pending', 'failed', 'unknown'.
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'boolean') return raw ? 'verified' : 'pending';
  const s = String(raw).toUpperCase();
  if (s === 'SUCCESS' || s === 'VERIFIED' || s === 'TRUE') return 'verified';
  if (s === 'PENDING' || s === 'NOT_STARTED' || s === 'FALSE') return 'pending';
  if (s === 'FAILED' || s === 'TEMPORARY_FAILURE') return 'failed';
  return String(raw).toLowerCase();
}
