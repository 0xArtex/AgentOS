import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth";
import { db } from "../db";
import { v4 as uuid } from "uuid";
import { AuthenticatedRequest } from "../types";
import { namecheapRequest, type NamecheapResponse } from "../services/namecheap";
import {
  createRegistrationJob,
  getRegistrationJob,
  hasActiveRegistration,
  DomainInFlightError,
} from "../services/domain-registration";
import { refundAndRespond } from "../services/refund";

const router = Router();

interface DomainCheckResult {
  available: boolean;
  domain: string;
  premium: boolean;
  price: number;
}

interface DnsRecord {
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'URL' | 'URL301';
  name: string;
  value: string;
  ttl?: number;
}

interface DomainDbRecord {
  id: string;
  domain: string;
  owner: string;
  registrar_id: string | null;
  status: string;
  expires_at: string;
  created_at: string;
  dns_records: string | null;
  shared_with: string | null;
}

/** Parse the shared_with JSON column, tolerating null/malformed rows. */
function parseSharedWith(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(w => typeof w === "string") : [];
  } catch {
    return [];
  }
}

/** True if `wallet` is the owner or has shared access to this domain. */
function canAccessDomain(row: Pick<DomainDbRecord, "owner" | "shared_with">, wallet: string): boolean {
  if (!wallet) return false;
  if (row.owner === wallet) return true;
  return parseSharedWith(row.shared_with).includes(wallet);
}

// Cache for pricing data
const pricingCache = new Map<string, { price: number; timestamp: number }>();
const PRICING_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

// namecheapRequest now imported from src/services/namecheap.ts

/**
 * Get pricing for a specific TLD from Namecheap
 */
async function getTldPrice(tld: string): Promise<number> {
  const cacheKey = tld.toLowerCase();
  const cached = pricingCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < PRICING_CACHE_DURATION) {
    return cached.price;
  }

  try {
    // Query pricing for specific TLD
    const apiUser = process.env.NAMECHEAP_API_USER;
    const apiKey = process.env.NAMECHEAP_API_KEY;
    const url = `https://api.namecheap.com/xml.response?ApiUser=${apiUser}&ApiKey=${apiKey}&UserName=${apiUser}&ClientIp=${process.env.NAMECHEAP_CLIENT_IP || '77.42.89.233'}&Command=namecheap.users.getPricing&ProductType=DOMAIN&ProductCategory=REGISTER&ProductName=${tld.toLowerCase()}`;
    
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const xml = await resp.text();
    
    // Extract YourPrice for Duration="1" (1 year)
    const match = xml.match(/Duration="1"[^/]*YourPrice="([^"]+)"/);
    if (match) {
      const price = parseFloat(match[1]);
      // Also add ICANN fee if present
      const icannMatch = xml.match(/Duration="1"[^/]*YourAdditonalCost="([^"]+)"/);
      const icann = icannMatch ? parseFloat(icannMatch[1]) : 0;
      const total = price + icann;
      pricingCache.set(cacheKey, { price: total, timestamp: Date.now() });
      return total;
    }
    
    throw new Error('Price not found in response');
  } catch (error) {
    console.warn(`[domains] Failed to get pricing for .${tld}:`, error);
    const defaults: Record<string, number> = {
      'com': 18.48, 'net': 18.58, 'org': 15.98, 'dev': 12.98,
      'xyz': 2.20, 'io': 34.98, 'app': 12.98, 'ai': 79.98
    };
    return defaults[tld.toLowerCase()] || 15.98;
  }
}

/**
 * GET /domains/check?domain=example.com
 * Check domain availability and pricing. If `domain` has no TLD, expands
 * across popular TLDs in a single batch call and returns a list.
 */
const POPULAR_TLDS = ['xyz', 'com', 'dev', 'io', 'ai', 'app', 'net', 'org'];
router.get('/check', async (req: Request, res: Response) => {
  try {
    const { domain } = req.query;

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'domain parameter is required' });
    }

    // Bare-name path: expand across popular TLDs and batch-check via Namecheap.
    if (!domain.includes('.')) {
      if (!/^[a-zA-Z0-9-]{1,63}$/.test(domain)) {
        return res.status(400).json({ error: 'Invalid name — use alphanumerics and hyphens only' });
      }
      const candidates = POPULAR_TLDS.map(t => `${domain}.${t}`);
      try {
        const [checkResult, ...priceResults] = await Promise.all([
          namecheapRequest('namecheap.domains.check', { DomainList: candidates.join(',') }),
          ...POPULAR_TLDS.map(t => getTldPrice(t))
        ]);
        const priceByTld: Record<string, number> = {};
        POPULAR_TLDS.forEach((t, i) => {
          priceByTld[t] = Math.round((priceResults[i] as number) * 1.25 * 100) / 100;
        });
        const rows = (checkResult.results || []) as Array<{ domain: string; available: boolean; premium: boolean }>;
        const results = rows.map(r => {
          const tld = r.domain.split('.').slice(1).join('.');
          return { domain: r.domain, available: r.available, premium: r.premium, price: priceByTld[tld] };
        });
        return res.json({ query: domain, results });
      } catch (apiError) {
        console.warn('[domains] Batch check failed:', apiError);
        return res.status(503).json({ error: 'Registrar unreachable — try again shortly' });
      }
    }

    const domainParts = domain.split('.');
    if (domainParts.length < 2) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    const tld = domainParts.slice(1).join('.');
    
    // Default pricing with markup
    const defaultPricing: Record<string, number> = {
      'com': 14.28, 'net': 16.48, 'org': 16.48, 'dev': 14.28,
      'xyz': 14.28, 'io': 43.98, 'app': 21.98
    };
    
    try {
      // Try Namecheap API with timeout
      const checkResult = await namecheapRequest('namecheap.domains.check', {
        DomainList: domain
      });

      const basePrice = await getTldPrice(tld);
      const markupPrice = Math.round(basePrice * 1.25 * 100) / 100;

      const result: DomainCheckResult = {
        available: checkResult.available || false,
        domain,
        premium: checkResult.isPremiumName || false,
        price: markupPrice
      };

      res.json(result);
    } catch (apiError) {
      console.warn('[domains] API unavailable, using mock response:', apiError);
      
      // Mock response for testing when API is down
      // Known unavailable domains for testing
      const knownUnavailable = ['google.com', 'facebook.com', 'youtube.com', 'amazon.com'];
      const available = !knownUnavailable.includes(domain.toLowerCase());
      
      const result: DomainCheckResult = {
        available,
        domain,
        premium: false,
        price: defaultPricing[tld] || 17.58
      };

      res.json({
        ...result,
        note: 'Mock response (Namecheap API temporarily unavailable)'
      });
    }
  } catch (error: any) {
    console.error('[domains] Check error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /domains/pricing
 * Get pricing for popular TLDs
 */
router.get('/pricing', async (_req: Request, res: Response) => {
  const tlds = ['com', 'net', 'org', 'dev', 'xyz', 'io', 'app', 'ai'];
  const pricing: Record<string, number> = {};
  
  await Promise.all(tlds.map(async (tld) => {
    const base = await getTldPrice(tld);
    pricing[tld] = Math.round(base * 1.25 * 100) / 100; // 25% markup
  }));

  res.json({
    currency: 'USDC',
    pricing,
    note: 'Prices in USDC with 25% service fee. 1-year registration.',
  });
});

/**
 * Per-domain dynamic pricing gate + preflight for /register. Runs before
 * requireAuth so a doomed registration never consumes the payer's USDC:
 *   - Correct per-TLD price for the 402 response
 *   - Domain still available at Namecheap (races with another registrant)
 *   - Already in our DB (paid by someone else already)
 *   - Namecheap account has enough balance to actually register
 * Only after those checks pass do we defer to requireAuth for the x402 cycle.
 */
const DOMAIN_REGISTER_TYPICAL_USDC = 10.0;
const DOMAIN_REGISTER_META = {
  description: "Register a domain for one year via Namecheap. Pricing is dynamic per-TLD — the 402 challenge returns the exact USDC amount (~$10 typical). Body: { domain }",
  category: "domains",
  tags: ["domain", "register", "namecheap"],
};

async function requireDomainPayment(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  // Discovery probe (x402scan/Bazaar crawl an empty body with no payment header):
  // issue a representative 402 challenge so the advertised route is indexable.
  // Real callers who supply a domain fall through to the exact per-TLD price.
  const hasPayment = !!(req.headers['payment-signature'] || req.headers['x-payment']);
  if (!hasPayment && !req.body?.domain) {
    return requireAuth(DOMAIN_REGISTER_TYPICAL_USDC, 'general', DOMAIN_REGISTER_META)(req, res, next);
  }

  const domain = typeof req.body?.domain === 'string' ? req.body.domain : null;
  if (!domain) {
    res.status(400).json({ error: 'domain is required' });
    return;
  }
  const parts = domain.split('.');
  if (parts.length < 2) {
    res.status(400).json({ error: 'Invalid domain format' });
    return;
  }

  const existing = db.prepare('SELECT id FROM domains WHERE domain = ?').get(domain);
  if (existing) {
    res.status(409).json({ error: 'Domain already registered in Palmyr' });
    return;
  }
  // Reject a domain that already has a registration in flight BEFORE charging —
  // otherwise the caller pays for a registration guaranteed to refund.
  if (hasActiveRegistration(domain)) {
    res.status(409).json({
      error: 'A registration for this domain is already in progress',
      error_code: 'registration_in_flight',
      hint: 'Your wallet has NOT been charged. Wait for the in-flight registration to finish, then re-check availability.',
    });
    return;
  }

  const tld = parts.slice(1).join('.');
  const basePrice = await getTldPrice(tld);
  const finalPrice = Math.round(basePrice * 1.25 * 100) / 100;

  // Run both registrar preflight calls in parallel to stay well under edge
  // timeouts (Cloudflare 100s / nginx 60s). Availability is hard-required;
  // balance is best-effort — if it errors we proceed rather than block.
  const [checkRes, balRes] = await Promise.allSettled([
    namecheapRequest('namecheap.domains.check', { DomainList: domain }),
    namecheapRequest('namecheap.users.getBalances'),
  ]);

  // 503s here all share the same "try again shortly" shape — agents that
  // get one should back off rather than immediately retry. 5 minutes is the
  // empirical floor: registrar balance refills are operator-driven (manual
  // top-up or scheduled funding), so polling every few seconds is wasted
  // network. The header is RFC 7231 §7.1.3.
  const RETRY_AFTER_SECS = 300;

  if (checkRes.status === 'rejected') {
    console.error('[domains] Preflight availability check failed:', checkRes.reason);
    res.setHeader('Retry-After', String(RETRY_AFTER_SECS));
    res.status(503).json({
      error: 'Registrar unreachable — try again shortly',
      error_code: 'registrar_unreachable',
      retry_after_seconds: RETRY_AFTER_SECS,
      hint: 'Your wallet has NOT been charged. The check ran before x402 settlement.',
    });
    return;
  }
  if (!checkRes.value.available) {
    res.status(409).json({
      error: 'Domain is not available for registration',
      error_code: 'unavailable',
      hint: 'Your wallet has NOT been charged.',
    });
    return;
  }

  if (balRes.status === 'fulfilled') {
    const avail = balRes.value.availableBalance;
    if (typeof avail === 'number' && avail < basePrice) {
      console.error(`[domains] Registrar balance too low: have ${avail}, need ${basePrice} for ${domain}`);
      res.setHeader('Retry-After', String(RETRY_AFTER_SECS));
      res.status(503).json({
        // Public-safe message: don't leak the exact operator balance, just the
        // structured signal an agent needs to back off. Operators get the
        // concrete number from the server log above.
        error: 'Registrar temporarily cannot fulfill this registration — try again shortly',
        error_code: 'registrar_balance_low',
        retry_after_seconds: RETRY_AFTER_SECS,
        hint: 'Your wallet has NOT been charged. This is an operator-side issue (Namecheap balance below the registration cost) — the operator has been pinged via server logs.',
      });
      return;
    }
  } else {
    console.warn('[domains] Balance preflight skipped:', balRes.reason?.message || balRes.reason);
  }

  return requireAuth(finalPrice, 'general')(req, res, next);
}

// Discovery markers. requireDomainPayment computes the real per-TLD price and
// delegates to requireAuth() *dynamically* at request time, so the price tag
// never lands on a registered layer for route-discovery.ts to find — leaving
// the headline "register a domain" op invisible in /openapi.json and
// /.well-known/x402. Tag the middleware itself so the walker enumerates it.
// The advertised amount is representative (matches the i402 registry seed);
// the 402 challenge returns the exact per-TLD price.
(requireDomainPayment as any)._x402PaidMin = DOMAIN_REGISTER_TYPICAL_USDC;
(requireDomainPayment as any)._x402ServiceType = 'general';
(requireDomainPayment as any)._x402Metadata = DOMAIN_REGISTER_META;

/**
 * POST /domains/register
 * Register a new domain
 */
router.post('/register', requireDomainPayment, async (req: AuthenticatedRequest, res: Response) => {
  const { domain } = req.body || {};

  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ error: 'domain is required' });
  }

  // Payment has settled (x402 runs before this handler). Capture everything the
  // background worker needs to register the domain and, on failure, refund the
  // payer — independent of this request's lifecycle.
  const owner = req.payment?.payer || req.agentId || 'unknown';
  const paymentSignature = req.payment?.signature || null;
  const paymentChain = req.payment?.chain || null;
  const chargedUsdc = req.payment ? Number(req.payment.amountLamports) / 1_000_000 : null;
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  // Race: the domain landed in the registry between preflight and settlement (a
  // concurrent caller, or a legacy synchronous registration). They paid but
  // can't have it — refund automatically and tell them.
  const already = db.prepare('SELECT id FROM domains WHERE domain = ?').get(domain);
  if (already) {
    console.error('[domains] domain claimed between preflight and settlement — auto-refunding', {
      domain, owner, signature: paymentSignature, chargedUsdc,
    });
    await refundAndRespond(req, res, {
      reason: 'domain registered by another caller before settlement',
      httpStatus: 409,
      errorLabel: 'Domain already registered',
      userMessage: 'This domain was registered by another caller after you paid. Your payment is being refunded automatically.',
    });
    return;
  }

  // Start the async registration job. The registrar call (slow + money-moving)
  // runs in the background, crash-recoverable and auto-refunding on failure —
  // see services/domain-registration.ts. The job's partial-unique index rejects
  // a second in-flight registration of the same domain (the narrow race between
  // the preflight check and this insert) → refund the loser.
  let job;
  try {
    job = createRegistrationJob({ domain, owner, paymentSignature, paymentChain, chargedUsdc, expiresAt });
  } catch (e: any) {
    if (e instanceof DomainInFlightError) {
      await refundAndRespond(req, res, {
        reason: 'concurrent registration already in flight',
        httpStatus: 409,
        errorLabel: 'Domain already being registered',
        userMessage: 'Another registration for this domain is already in flight. Your payment is being refunded automatically.',
      });
      return;
    }
    console.error('[domains] could not start registration job — auto-refunding', { domain, owner, error: e?.message || String(e) });
    await refundAndRespond(req, res, {
      reason: `could not start registration job: ${e?.message || e}`,
      httpStatus: 500,
      errorLabel: 'Could not start registration',
      userMessage: 'We could not start your registration. Your payment is being refunded automatically.',
    });
    return;
  }

  // 202 Accepted — registration is processing in the background. Poll the
  // operation until it's terminal (active | failed). On failure the worker
  // refunds automatically and `refund_status` reflects it.
  res.status(202).json({
    operation_id: job.id,
    status: job.status,
    poll_url: `/domains/operations/${job.id}`,
    poll_after_seconds: 5,
    domain,
    expiresAt,
    cost: chargedUsdc,
    message: `Registration accepted and processing. Poll GET /domains/operations/${job.id} until status is 'active' or 'failed'.`,
  });
});

/**
 * GET /domains/operations/:id
 * Poll an async domain registration you started. Owner-only — the x402
 * signature proves who's asking; a non-owner or unknown id gets 404 so
 * operations can't be enumerated across wallets. status: pending → registering
 * → active | failed. On 'failed', `refund_status` reflects the auto-refund.
 *
 * Fee is 0.01 USDC, not the symbolic 0.0001: amounts below ~0.01 fall under
 * Coinbase CDP's enforced Base minimum and surface as cdp_error on every
 * Base-paid poll (Solana has no such floor).
 */
router.get(
  '/operations/:id',
  requireAuth(0.01, 'general', {
    description: 'Poll the status of a domain registration you started (owner-only).',
    category: 'domains',
    tags: ['domain', 'register', 'status', 'poll'],
  }),
  (req: AuthenticatedRequest, res: Response) => {
    const caller = req.payment?.payer || req.agentId;
    if (!caller) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const job = getRegistrationJob(String(req.params.id || ''));
    if (!job || job.owner !== caller) {
      // 404 not 403 — don't reveal another wallet's operation exists.
      res.status(404).json({ error: 'Operation not found' });
      return;
    }
    res.json({
      operation_id: job.id,
      status: job.status,
      done: job.status === 'active' || job.status === 'failed',
      domain: job.domain,
      poll_url: `/domains/operations/${job.id}`,
      expiresAt: job.expires_at,
      cost: job.charged_usdc,
      registrar_order_id: job.registrar_order_id,
      error: job.error,
      error_code: job.error_code,
      refund_status: job.refund_status,
      dnsManagement: job.status === 'active',
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
    });
  }
);

// Ownership proof via x402 micro-payment — the payer's signature on the USDC
// transfer cryptographically proves they control the owner wallet. The amount
// stays symbolic (one cent), but the previous 0.0001 USDC (= 100 atomic units)
// fell below Coinbase CDP's enforced minimum and surfaced as
// `cdp_error: invalid_payload` for every Base-paid call — Solana worked because
// the SVM verifier doesn't apply that floor. 0.01 USDC matches the "general
// ops" tier already used by compute reads, which is the cheapest Base amount
// we've observed CDP accept end-to-end.
const OWNERSHIP_PROOF_USDC = 0.01;
const ownerFromRequest = (req: AuthenticatedRequest): string | undefined =>
  req.payment?.payer || req.agentId;

/**
 * GET /domains
 * List all domains owned by the calling wallet. Requires x402 ownership
 * proof — the payer's signature implicitly identifies which wallet to
 * filter by, so wallets can't enumerate each other's portfolios for free.
 */
router.get('/', requireAuth(OWNERSHIP_PROOF_USDC, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const owner = ownerFromRequest(req);
    if (!owner) {
      return res.status(400).json({ error: 'No wallet identity on request' });
    }
    // Pull rows owned OR mentioned in shared_with. SQLite can't query JSON
    // arrays natively, so the LIKE filters by substring and we refine in JS.
    const rows = db.prepare(`
      SELECT domain, owner, status, registrar_id, expires_at, created_at, shared_with
      FROM domains
      WHERE owner = ? OR shared_with LIKE ?
      ORDER BY created_at DESC
    `).all(owner, `%${owner}%`) as Array<DomainDbRecord>;

    const domains = rows
      .filter(r => canAccessDomain(r, owner))
      .map(r => ({
        domain: r.domain,
        status: r.status,
        registrar_id: r.registrar_id,
        expires_at: r.expires_at,
        created_at: r.created_at,
        access: r.owner === owner ? "owner" : "shared",
        ...(r.owner === owner ? { shared_with: parseSharedWith(r.shared_with) } : {}),
      }));
    res.json({ owner, count: domains.length, domains });
  } catch (error: any) {
    console.error('[domains] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /domains/:domain
 * Get domain information. Requires x402 ownership proof.
 */
router.get('/:domain', requireAuth(OWNERSHIP_PROOF_USDC, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { domain } = req.params;

    const caller = ownerFromRequest(req);
    const domainRecord = db.prepare('SELECT * FROM domains WHERE domain = ?').get(domain) as DomainDbRecord | undefined;
    if (!domainRecord || !caller || !canAccessDomain(domainRecord, caller)) {
      return res.status(404).json({ error: 'Domain not found or not accessible by you' });
    }

    const dnsRecords = domainRecord.dns_records ? JSON.parse(domainRecord.dns_records) : [];
    const isOwner = domainRecord.owner === caller;

    res.json({
      domain: domainRecord.domain,
      status: domainRecord.status,
      expiresAt: domainRecord.expires_at,
      createdAt: domainRecord.created_at,
      dnsRecords,
      access: isOwner ? "owner" : "shared",
      ...(isOwner ? { shared_with: parseSharedWith(domainRecord.shared_with) } : {}),
    });
  } catch (error: any) {
    console.error('[domains] Get domain error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /domains/:domain/dns
 * Get current DNS records. Requires x402 ownership proof.
 */
router.get('/:domain/dns', requireAuth(OWNERSHIP_PROOF_USDC, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { domain } = req.params;

    const caller = ownerFromRequest(req);
    const domainRecord = db.prepare('SELECT * FROM domains WHERE domain = ?').get(domain) as DomainDbRecord | undefined;
    if (!domainRecord || !caller || !canAccessDomain(domainRecord, caller)) {
      return res.status(404).json({ error: 'Domain not found or not accessible by you' });
    }

    try {
      // Get DNS records from Namecheap
      const dnsResult = await namecheapRequest('namecheap.domains.dns.getHosts', {
        SLD: (domain as string).split('.')[0],
        TLD: (domain as string).split('.').slice(1).join('.')
      });

      const records = (dnsResult.hosts || []).map((host: any) => ({
        type: host.type,
        name: host.name,
        value: host.address,
        ttl: parseInt(host.ttl) || 1800
      }));

      // Update cached records in DB
      db.prepare('UPDATE domains SET dns_records = ? WHERE domain = ?').run(JSON.stringify(records), domain);

      res.json(records);
    } catch (error) {
      // If Namecheap API fails, return cached records
      console.warn('[domains] Failed to fetch DNS from Namecheap, using cached:', error);
      const cachedRecords = domainRecord.dns_records ? JSON.parse(domainRecord.dns_records) : [];
      res.json(cachedRecords);
    }
  } catch (error: any) {
    console.error('[domains] Get DNS error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /domains/:domain/dns
 * Set DNS records. Requires x402 ownership proof.
 */
router.post('/:domain/dns', requireAuth(OWNERSHIP_PROOF_USDC, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { domain } = req.params;
    const { records } = req.body;

    if (!records || !Array.isArray(records)) {
      return res.status(400).json({ error: 'records array is required' });
    }

    const caller = ownerFromRequest(req);
    const domainRecord = db.prepare('SELECT * FROM domains WHERE domain = ?').get(domain) as DomainDbRecord | undefined;
    if (!domainRecord || !caller || !canAccessDomain(domainRecord, caller)) {
      return res.status(404).json({ error: 'Domain not found or not accessible by you' });
    }

    // Validate records
    const validTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'URL', 'URL301'];
    for (const record of records) {
      if (!validTypes.includes(record.type)) {
        return res.status(400).json({ error: `Invalid record type: ${record.type}` });
      }
      if (!record.name || !record.value) {
        return res.status(400).json({ error: 'Record name and value are required' });
      }
    }

    try {
      // Prepare hosts for Namecheap API
      const hosts = records.map((record: DnsRecord, index: number) => {
        const params: Record<string, string> = {};
        params[`HostName${index + 1}`] = record.name;
        params[`RecordType${index + 1}`] = record.type;
        params[`Address${index + 1}`] = record.value;
        params[`TTL${index + 1}`] = (record.ttl || 1800).toString();
        if (record.type === 'MX') {
          params[`MXPref${index + 1}`] = '10'; // Default MX priority
        }
        return params;
      }).reduce((acc, params) => ({ ...acc, ...params }), {});

      // Namecheap ignores host-level MX rows while the domain is in FWD/MXE
      // email mode; EmailType='MX' tells it to honor them. Only set it when the
      // caller actually sent MX records (mirrors services/namecheap.ts
      // setDomainDnsRecords) so non-MX setups like Gmail/Workspace aren't clobbered.
      const hasMx = records.some((r: DnsRecord) => r.type === 'MX');
      await namecheapRequest('namecheap.domains.dns.setHosts', {
        SLD: (domain as string).split('.')[0],
        TLD: (domain as string).split('.').slice(1).join('.'),
        ...hosts,
        ...(hasMx ? { EmailType: 'MX' } : {}),
      });

      // Update records in database
      db.prepare('UPDATE domains SET dns_records = ? WHERE domain = ?').run(JSON.stringify(records), domain);

      res.json({
        message: 'DNS records updated successfully',
        records
      });
    } catch (error: any) {
      console.error('[domains] DNS update error:', error);
      res.status(500).json({ error: `Failed to update DNS records: ${error.message}` });
    }
  } catch (error: any) {
    console.error('[domains] Set DNS error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /domains/:domain/transfer-ownership
 * Transfer domain ownership to another wallet. Domain stays with our registrar;
 * only the DB owner changes. Current owner proves control via x402 payment
 * signature — the payer pubkey must match the current owner row.
 */
// Owners are wallet addresses on either chain x402 settles on:
//   Solana: base58, 32–44 chars
//   EVM (Base): 0x + 40 hex chars
const SOL_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;
const isWalletAddress = (s: string) => SOL_PUBKEY.test(s) || EVM_ADDR.test(s);

router.post('/:domain/transfer-ownership', requireAuth(OWNERSHIP_PROOF_USDC, 'general', {
  description: "Transfer a domain you own to another wallet. Clears shared access. Body: { new_owner }",
  category: "domains",
  tags: ["domain", "transfer", "ownership"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { domain } = req.params;
    const { new_owner } = req.body || {};

    if (!new_owner || typeof new_owner !== 'string' || !isWalletAddress(new_owner)) {
      return res.status(400).json({ error: 'new_owner must be a Solana (base58) or EVM (0x…) wallet address' });
    }

    const owner = ownerFromRequest(req);
    const domainRecord = db.prepare('SELECT * FROM domains WHERE domain = ? AND owner = ?').get(domain, owner) as DomainDbRecord | undefined;
    if (!domainRecord) {
      return res.status(404).json({ error: 'Domain not found or not owned by you' });
    }

    if (new_owner === owner) {
      return res.status(400).json({ error: 'new_owner is already the current owner' });
    }

    // Clear shared_with on transfer — the previous owner's collaborators
    // don't travel with the domain. New owner can re-share if desired.
    db.prepare("UPDATE domains SET owner = ?, shared_with = '[]' WHERE id = ?").run(new_owner, domainRecord.id);

    res.json({
      message: 'Ownership transferred',
      domain: domainRecord.domain,
      previous_owner: owner,
      new_owner
    });
  } catch (error: any) {
    console.error('[domains] Transfer ownership error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /domains/:domain/share
 * Grant another wallet shared access (visibility + DNS edits). Owner-only.
 * Body: { with: "<wallet>" }
 */
router.post('/:domain/share', requireAuth(OWNERSHIP_PROOF_USDC, 'general', {
  description: "Grant another wallet shared access (view + DNS edits) to a domain you own. Body: { with }",
  category: "domains",
  tags: ["domain", "share", "dns"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { domain } = req.params;
    const withWallet = (req.body || {}).with;
    if (!withWallet || typeof withWallet !== 'string' || !isWalletAddress(withWallet)) {
      return res.status(400).json({ error: '`with` must be a Solana (base58) or EVM (0x…) wallet address' });
    }

    const owner = ownerFromRequest(req);
    const domainRecord = db.prepare('SELECT * FROM domains WHERE domain = ? AND owner = ?').get(domain, owner) as DomainDbRecord | undefined;
    if (!domainRecord) {
      return res.status(404).json({ error: 'Domain not found or not owned by you' });
    }

    if (withWallet === owner) {
      return res.status(400).json({ error: 'Cannot share with the current owner' });
    }

    const current = parseSharedWith(domainRecord.shared_with);
    const next = current.includes(withWallet) ? current : [...current, withWallet];
    db.prepare('UPDATE domains SET shared_with = ? WHERE id = ?').run(JSON.stringify(next), domainRecord.id);

    res.json({
      message: `${domainRecord.domain} shared with ${withWallet}`,
      domain: domainRecord.domain,
      shared_with: next,
    });
  } catch (error: any) {
    console.error('[domains] Share error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /domains/:domain/unshare
 * Revoke shared access from a wallet. Owner-only.
 * Body: { wallet: "<wallet>" }
 */
router.post('/:domain/unshare', requireAuth(OWNERSHIP_PROOF_USDC, 'general', {
  description: "Revoke a wallet's shared access to a domain you own. Body: { wallet }",
  category: "domains",
  tags: ["domain", "unshare"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { domain } = req.params;
    const targetWallet = (req.body || {}).wallet;
    if (!targetWallet || typeof targetWallet !== 'string' || !isWalletAddress(targetWallet)) {
      return res.status(400).json({ error: '`wallet` must be a Solana (base58) or EVM (0x…) wallet address' });
    }

    const owner = ownerFromRequest(req);
    const domainRecord = db.prepare('SELECT * FROM domains WHERE domain = ? AND owner = ?').get(domain, owner) as DomainDbRecord | undefined;
    if (!domainRecord) {
      return res.status(404).json({ error: 'Domain not found or not owned by you' });
    }

    const next = parseSharedWith(domainRecord.shared_with).filter(w => w !== targetWallet);
    db.prepare('UPDATE domains SET shared_with = ? WHERE id = ?').run(JSON.stringify(next), domainRecord.id);

    res.json({
      message: `${targetWallet} no longer has shared access to ${domainRecord.domain}`,
      domain: domainRecord.domain,
      shared_with: next,
    });
  } catch (error: any) {
    console.error('[domains] Unshare error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /domains/:domain/transfer
 * Initiate domain transfer out. Requires x402 ownership proof.
 */
router.post('/:domain/transfer', requireAuth(OWNERSHIP_PROOF_USDC, 'general', {
  description: "Initiate an outbound registrar transfer for a domain you own (returns the EPP/auth code). Owner-only.",
  category: "domains",
  tags: ["domain", "transfer", "registrar", "epp"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { domain } = req.params;

    const owner = ownerFromRequest(req);
    const domainRecord = db.prepare('SELECT * FROM domains WHERE domain = ? AND owner = ?').get(domain, owner) as DomainDbRecord | undefined;
    if (!domainRecord) {
      return res.status(404).json({ error: 'Domain not found or not owned by you' });
    }

    try {
      // First unlock the domain if needed
      await namecheapRequest('namecheap.domains.setRegistrarLock', {
        SLD: (domain as string).split('.')[0],
        TLD: (domain as string).split('.').slice(1).join('.'),
        LockAction: 'UNLOCK'
      });

      // Get EPP/auth code
      const eppResult = await namecheapRequest('namecheap.domains.getEPPCode', {
        SLD: (domain as string).split('.')[0],
        TLD: (domain as string).split('.').slice(1).join('.')
      });

      // Parse EPP code from XML response
      const eppMatch = eppResult.raw?.match(/<EppCode>(.*?)<\/EppCode>/);
      const authCode = eppMatch ? eppMatch[1] : null;

      if (!authCode) {
        return res.status(500).json({ error: 'Failed to retrieve auth code' });
      }

      res.json({
        message: 'Transfer initiated successfully',
        authCode,
        instructions: 'Use this auth code with your new registrar to complete the transfer'
      });
    } catch (error: any) {
      console.error('[domains] Transfer error:', error);
      res.status(500).json({ error: `Failed to initiate transfer: ${error.message}` });
    }
  } catch (error: any) {
    console.error('[domains] Transfer error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;