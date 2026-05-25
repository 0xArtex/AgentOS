import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth";
import { db } from "../db";
import { v4 as uuid } from "uuid";
import { AuthenticatedRequest } from "../types";
import { namecheapRequest, type NamecheapResponse } from "../services/namecheap";

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
    const url = `https://api.namecheap.com/xml.response?ApiUser=${apiUser}&ApiKey=${apiKey}&UserName=${apiUser}&ClientIp=77.42.89.233&Command=namecheap.users.getPricing&ProductType=DOMAIN&ProductCategory=REGISTER&ProductName=${tld.toLowerCase()}`;
    
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
    note: 'Prices in USDC with 10% service fee. 1-year registration.',
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
async function requireDomainPayment(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
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

/**
 * POST /domains/register
 * Register a new domain
 */
router.post('/register', requireDomainPayment, async (req: AuthenticatedRequest, res: Response) => {
  const { domain } = req.body || {};

  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ error: 'domain is required' });
  }

  // Payment has already settled by the time we're here. Capture everything we
  // need to trace or refund this specific x402 transfer, independent of what
  // happens with the registrar below.
  const owner = req.payment?.payer || req.agentId;
  const paymentSignature = req.payment?.signature || null;
  const domainId = uuid();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const domainParts = domain.split('.');
  const tld = domainParts.slice(1).join('.');
  const basePrice = await getTldPrice(tld);
  const finalPrice = Math.round(basePrice * 1.25 * 100) / 100;

  // Race check: another paid caller may have registered this domain between
  // preflight and settlement.
  const existing = db.prepare('SELECT id FROM domains WHERE domain = ?').get(domain);
  if (existing) {
    console.error('[domains] [REFUND NEEDED] Domain claimed between preflight and settlement', {
      domain, owner, signature: paymentSignature, chargedUsdc: finalPrice
    });
    return res.status(409).json({
      error: 'Domain was registered by another caller after you paid. Your payment has been logged for refund.',
      refund_signature: paymentSignature
    });
  }

  // Step 1: INSERT a 'pending' row BEFORE we call the registrar. If the INSERT
  // fails (schema drift, constraint bug), we'll know before spending money at
  // Namecheap — the user is owed only the x402 payment, not the registrar fee.
  // We build the column list dynamically to accommodate older prod schemas
  // that still have extra NOT NULL columns (tld, registrar, registered_at).
  const domainsCols = db.prepare("PRAGMA table_info(domains)").all() as Array<{ name: string }>;
  const have = new Set(domainsCols.map(c => c.name));
  const cols: string[] = ['id', 'domain', 'owner', 'status', 'expires_at', 'created_at', 'dns_records'];
  const vals: any[] = [domainId, domain, owner, 'pending', expiresAt, now, '[]'];
  if (have.has('tld')) { cols.push('tld'); vals.push(tld); }
  if (have.has('registrar')) { cols.push('registrar'); vals.push('namecheap'); }
  if (have.has('registered_at')) { cols.push('registered_at'); vals.push(now); }
  if (have.has('payment_signature')) { cols.push('payment_signature'); vals.push(paymentSignature); }
  const placeholders = vals.map(() => '?').join(', ');

  try {
    db.prepare(`INSERT INTO domains (${cols.join(', ')}) VALUES (${placeholders})`).run(...vals);
  } catch (insertError: any) {
    console.error('[domains] [REFUND NEEDED] Pre-registration INSERT failed', {
      domain, owner, signature: paymentSignature, chargedUsdc: finalPrice, error: insertError.message
    });
    return res.status(500).json({
      error: 'Could not reserve domain record. Nothing was registered; your payment has been logged for refund.',
      refund_signature: paymentSignature
    });
  }

  // Step 2: call the registrar. Any failure from here on must UPDATE the
  // pending row so the registrar charge (if any) is traceable.
  let registerResult: NamecheapResponse;
  try {
    registerResult = await namecheapRequest('namecheap.domains.create', {
      DomainName: domain,
      Years: '1',
      // Use generic registrant info
      RegistrantFirstName: 'Palmyr',
      RegistrantLastName: 'Registry',
      RegistrantAddress1: '123 Agent Street',
      RegistrantCity: 'San Francisco',
      RegistrantStateProvince: 'CA',
      RegistrantPostalCode: '94102',
      RegistrantCountry: 'US',
      RegistrantPhone: '+1.4155551234',
      RegistrantEmailAddress: 'agent@palmyr.ai',
      // Tech contact (same as registrant)
      TechFirstName: 'Palmyr',
      TechLastName: 'Registry',
      TechAddress1: '123 Agent Street',
      TechCity: 'San Francisco',
      TechStateProvince: 'CA',
      TechPostalCode: '94102',
      TechCountry: 'US',
      TechPhone: '+1.4155551234',
      TechEmailAddress: 'agent@palmyr.ai',
      // Admin contact (same as registrant)
      AdminFirstName: 'Palmyr',
      AdminLastName: 'Registry',
      AdminAddress1: '123 Agent Street',
      AdminCity: 'San Francisco',
      AdminStateProvince: 'CA',
      AdminPostalCode: '94102',
      AdminCountry: 'US',
      AdminPhone: '+1.4155551234',
      AdminEmailAddress: 'agent@palmyr.ai',
      // Billing contact (same as registrant)
      BillingFirstName: 'Palmyr',
      BillingLastName: 'Registry',
      BillingAddress1: '123 Agent Street',
      BillingCity: 'San Francisco',
      BillingStateProvince: 'CA',
      BillingPostalCode: '94102',
      BillingCountry: 'US',
      BillingPhone: '+1.4155551234',
      BillingEmailAddress: 'agent@palmyr.ai',
      // AuxBilling contact — required by Namecheap (error 2010218 without it).
      AuxBillingFirstName: 'Palmyr',
      AuxBillingLastName: 'Registry',
      AuxBillingAddress1: '123 Agent Street',
      AuxBillingCity: 'San Francisco',
      AuxBillingStateProvince: 'CA',
      AuxBillingPostalCode: '94102',
      AuxBillingCountry: 'US',
      AuxBillingPhone: '+1.4155551234',
      AuxBillingEmailAddress: 'agent@palmyr.ai'
    });
  } catch (regError: any) {
    // Registrar call itself threw (network, timeout, parse error). Registrar
    // either never received the request or we can't tell — mark failed and
    // log loudly so ops can verify before refunding.
    const reason = `registrar_call_threw: ${regError.message || regError}`;
    const failureSet = have.has('failure_reason') ? ", failure_reason = ?" : '';
    const failureArgs = have.has('failure_reason') ? [reason, domainId] : [domainId];
    db.prepare(`UPDATE domains SET status = 'failed'${failureSet} WHERE id = ?`).run(...failureArgs);
    console.error('[domains] [REFUND NEEDED] Registrar call threw', {
      domain, owner, signature: paymentSignature, chargedUsdc: finalPrice, error: regError.message
    });
    return res.status(502).json({
      error: `Registrar error: ${regError.message || regError}. Your payment has been logged for refund.`,
      refund_signature: paymentSignature
    });
  }

  // Step 3: check registration outcome.
  const rawSnippet = typeof registerResult.raw === 'string' ? registerResult.raw.slice(0, 600) : null;
  if (!registerResult.success) {
    const reason = `registrar_rejected: registered=${registerResult.registered ?? 'null'} orderId=${registerResult.orderId || 'null'}`;
    const failureSet = have.has('failure_reason') ? ", failure_reason = ?" : '';
    const failureArgs = have.has('failure_reason') ? [reason, domainId] : [domainId];
    db.prepare(`UPDATE domains SET status = 'failed'${failureSet} WHERE id = ?`).run(...failureArgs);
    console.error('[domains] [REFUND NEEDED] Registrar declined post-payment', {
      domain, owner, signature: paymentSignature, chargedUsdc: finalPrice,
      namecheapOrderId: registerResult.orderId || null,
      namecheapRegistered: registerResult.registered ?? null,
      namecheapRaw: rawSnippet,
    });
    // 422 not 502 — Cloudflare overwrites origin 502 with its own page.
    return res.status(422).json({
      error: 'Registration failed at registrar — your payment has been logged for manual refund. Contact support with this domain name.',
      domain,
      refund_signature: paymentSignature,
      registrar: {
        registered: registerResult.registered ?? false,
        orderId: registerResult.orderId || null,
        rawSnippet,
      },
    });
  }

  // Step 4: registrar confirmed. Finalize the row. If this UPDATE fails we
  // have an orphan (registered at registrar, no clean DB state) — return
  // success to the payer anyway since they do own the domain, and log
  // loudly for manual reconciliation.
  try {
    db.prepare(`UPDATE domains SET status = 'active', registrar_id = ? WHERE id = ?`)
      .run(registerResult.orderId, domainId);
  } catch (finalizeError: any) {
    console.error('[domains] [ORPHAN] Finalize UPDATE failed — user owns domain at registrar', {
      domain, owner, signature: paymentSignature,
      registrarOrderId: registerResult.orderId,
      error: finalizeError.message,
    });
    // Do not fail the response — user paid and got the domain. Reconcile async.
  }

  res.status(201).json({
    domain,
    status: 'active',
    expiresAt,
    dnsManagement: true,
    cost: finalPrice
  });
});

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

      // Set DNS records via Namecheap
      await namecheapRequest('namecheap.domains.dns.setHosts', {
        SLD: (domain as string).split('.')[0],
        TLD: (domain as string).split('.').slice(1).join('.'),
        ...hosts
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

router.post('/:domain/transfer-ownership', requireAuth(OWNERSHIP_PROOF_USDC, 'general', { discoverable: false }), async (req: AuthenticatedRequest, res: Response) => {
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
router.post('/:domain/share', requireAuth(OWNERSHIP_PROOF_USDC, 'general', { discoverable: false }), async (req: AuthenticatedRequest, res: Response) => {
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
router.post('/:domain/unshare', requireAuth(OWNERSHIP_PROOF_USDC, 'general', { discoverable: false }), async (req: AuthenticatedRequest, res: Response) => {
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
router.post('/:domain/transfer', requireAuth(OWNERSHIP_PROOF_USDC, 'general', { discoverable: false }), async (req: AuthenticatedRequest, res: Response) => {
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