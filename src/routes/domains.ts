import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { db } from "../db";
import { v4 as uuid } from "uuid";
import { AuthenticatedRequest } from "../types";

const router = Router();

interface NamecheapResponse {
  [key: string]: any;
}

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
}

// Cache for pricing data
const pricingCache = new Map<string, { price: number; timestamp: number }>();
const PRICING_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

/**
 * Make Namecheap API request
 */
async function namecheapRequest(command: string, params: Record<string, string> = {}): Promise<NamecheapResponse> {
  const apiUser = process.env.NAMECHEAP_API_USER;
  const apiKey = process.env.NAMECHEAP_API_KEY;
  const clientIp = '77.42.89.233';
  
  if (!apiUser || !apiKey) {
    throw new Error('Namecheap API credentials not configured');
  }

  const baseParams = {
    ApiUser: apiUser,
    ApiKey: apiKey,
    UserName: apiUser,
    ClientIp: clientIp,
    Command: command
  };

  const allParams = { ...baseParams, ...params };
  const url = new URL('https://api.namecheap.com/xml.response');
  
  Object.entries(allParams).forEach(([key, value]) => {
    url.searchParams.append(key, value);
  });

  try {
    const response = await fetch(url.toString(), { 
      method: 'GET',
      signal: AbortSignal.timeout(10000) // 10 second timeout
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const xmlText = await response.text();

    // Simple XML parsing - extract key information
    const result: NamecheapResponse = { raw: xmlText };

    // Parse common response structure
    if (xmlText.includes('<Status>ERROR</Status>')) {
      const errorMatch = xmlText.match(/<Error Number="(\d+)">(.*?)<\/Error>/);
      throw new Error(errorMatch ? errorMatch[2] : 'Namecheap API error');
    }

    // Parse domain check response
    if (command === 'namecheap.domains.check') {
      const domainMatch = xmlText.match(/<DomainCheckResult Domain="([^"]*)" Available="([^"]*)".*?\/>/);
      if (domainMatch) {
        result.domain = domainMatch[1];
        result.available = domainMatch[2].toLowerCase() === 'true';
        result.isPremiumName = xmlText.includes('IsPremiumName="true"');
      }
    }

    // Parse pricing response
    if (command === 'namecheap.users.getPricing') {
      const priceMatches = xmlText.matchAll(/<ProductType Name="DOMAIN".*?<ProductCategory Name="REGISTER".*?<Product Name="([^"]*)".*?<Price Duration="1" DurationType="YEAR" Price="([^"]*)".*?\/>/g);
      result.pricing = {};
      for (const match of priceMatches) {
        result.pricing[match[1]] = parseFloat(match[2]);
      }
    }

    // Parse domain creation response
    if (command === 'namecheap.domains.create') {
      const orderIdMatch = xmlText.match(/<DomainCreateResult Domain="[^"]*" ChargedAmount="[^"]*" DomainID="[^"]*" OrderID="([^"]*)".*?\/>/);
      if (orderIdMatch) {
        result.orderId = orderIdMatch[1];
        result.success = true;
      }
    }

    // Parse DNS hosts response
    if (command === 'namecheap.domains.dns.getHosts') {
      result.hosts = [];
      const hostMatches = xmlText.matchAll(/<host HostId="[^"]*" Name="([^"]*)" Type="([^"]*)" Address="([^"]*)" MXPref="([^"]*)" TTL="([^"]*)".*?\/>/g);
      for (const match of hostMatches) {
        result.hosts.push({
          name: match[1],
          type: match[2],
          address: match[3],
          mxPref: match[4],
          ttl: match[5]
        });
      }
    }

    // Parse domain info response
    if (command === 'namecheap.domains.getInfo') {
      const expiresMatch = xmlText.match(/<DomainDetails.*?<DomainNameservers>.*?<\/DomainNameservers>.*?<\/DomainDetails>.*?<DnsDetails>.*?<\/DnsDetails>.*?<Whoisguard.*?ExpiredDate="([^"]*)".*?\/>/);
      if (expiresMatch) {
        result.expiresAt = expiresMatch[1];
      }
    }

    return result;
  } catch (error: any) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      throw new Error(`Namecheap API timeout: ${command}`);
    }
    throw new Error(`Namecheap API request failed: ${error.message}`);
  }
}

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
 * Check domain availability and pricing
 */
router.get('/check', async (req: Request, res: Response) => {
  try {
    const { domain } = req.query;

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'domain parameter is required' });
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
 * POST /domains/register
 * Register a new domain
 */
router.post('/register', requireAuth(20.0, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { domain } = req.body;

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'domain is required' });
    }

    // Check if domain is already registered in our DB
    const existing = db.prepare('SELECT id FROM domains WHERE domain = ?').get(domain);
    if (existing) {
      return res.status(409).json({ error: 'Domain already registered in AgentOS' });
    }

    // Verify availability first
    const checkResult = await namecheapRequest('namecheap.domains.check', {
      DomainList: domain
    });

    if (!checkResult.available) {
      return res.status(409).json({ error: 'Domain is not available for registration' });
    }

    // Get actual cost for verification
    const domainParts = domain.split('.');
    const tld = domainParts.slice(1).join('.');
    const basePrice = await getTldPrice(tld);
    const finalPrice = Math.round(basePrice * 1.25 * 100) / 100;

    // Register domain via Namecheap
    const registerResult = await namecheapRequest('namecheap.domains.create', {
      DomainName: domain,
      Years: '1',
      // Use generic registrant info
      RegistrantFirstName: 'AgentOS',
      RegistrantLastName: 'Registry',
      RegistrantAddress1: '123 Agent Street',
      RegistrantCity: 'San Francisco',
      RegistrantStateProvince: 'CA',
      RegistrantPostalCode: '94102',
      RegistrantCountry: 'US',
      RegistrantPhone: '+1.4155551234',
      RegistrantEmailAddress: 'agent@agntos.dev',
      // Tech contact (same as registrant)
      TechFirstName: 'AgentOS',
      TechLastName: 'Registry',
      TechAddress1: '123 Agent Street',
      TechCity: 'San Francisco',
      TechStateProvince: 'CA',
      TechPostalCode: '94102',
      TechCountry: 'US',
      TechPhone: '+1.4155551234',
      TechEmailAddress: 'agent@agntos.dev',
      // Admin contact (same as registrant)
      AdminFirstName: 'AgentOS',
      AdminLastName: 'Registry',
      AdminAddress1: '123 Agent Street',
      AdminCity: 'San Francisco',
      AdminStateProvince: 'CA',
      AdminPostalCode: '94102',
      AdminCountry: 'US',
      AdminPhone: '+1.4155551234',
      AdminEmailAddress: 'agent@agntos.dev',
      // Billing contact (same as registrant)
      BillingFirstName: 'AgentOS',
      BillingLastName: 'Registry',
      BillingAddress1: '123 Agent Street',
      BillingCity: 'San Francisco',
      BillingStateProvince: 'CA',
      BillingPostalCode: '94102',
      BillingCountry: 'US',
      BillingPhone: '+1.4155551234',
      BillingEmailAddress: 'agent@agntos.dev'
    });

    if (!registerResult.success) {
      return res.status(500).json({ error: 'Failed to register domain with Namecheap' });
    }

    // Store in database
    const domainId = uuid();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year from now
    
    db.prepare(`
      INSERT INTO domains (id, domain, owner, registrar_id, status, expires_at, created_at, dns_records)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(domainId, domain, req.agentId, registerResult.orderId, 'active', expiresAt, now, '[]');

    res.status(201).json({
      domain,
      status: 'active',
      expiresAt,
      dnsManagement: true,
      cost: finalPrice
    });
  } catch (error: any) {
    console.error('[domains] Register error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /domains/:domain
 * Get domain information
 */
router.get('/:domain', requireAuth(0, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { domain } = req.params;

    const domainRecord = db.prepare('SELECT * FROM domains WHERE domain = ? AND owner = ?').get(domain, req.agentId) as DomainDbRecord | undefined;
    if (!domainRecord) {
      return res.status(404).json({ error: 'Domain not found or not owned by you' });
    }

    const dnsRecords = domainRecord.dns_records ? JSON.parse(domainRecord.dns_records) : [];

    res.json({
      domain: domainRecord.domain,
      status: domainRecord.status,
      expiresAt: domainRecord.expires_at,
      createdAt: domainRecord.created_at,
      dnsRecords
    });
  } catch (error: any) {
    console.error('[domains] Get domain error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /domains/:domain/dns
 * Get current DNS records
 */
router.get('/:domain/dns', requireAuth(0, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { domain } = req.params;

    const domainRecord = db.prepare('SELECT * FROM domains WHERE domain = ? AND owner = ?').get(domain, req.agentId) as DomainDbRecord | undefined;
    if (!domainRecord) {
      return res.status(404).json({ error: 'Domain not found or not owned by you' });
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
 * Set DNS records
 */
router.post('/:domain/dns', requireAuth(0, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { domain } = req.params;
    const { records } = req.body;

    if (!records || !Array.isArray(records)) {
      return res.status(400).json({ error: 'records array is required' });
    }

    const domainRecord = db.prepare('SELECT * FROM domains WHERE domain = ? AND owner = ?').get(domain, req.agentId) as DomainDbRecord | undefined;
    if (!domainRecord) {
      return res.status(404).json({ error: 'Domain not found or not owned by you' });
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
 * POST /domains/:domain/transfer
 * Initiate domain transfer out
 */
router.post('/:domain/transfer', requireAuth(0, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { domain } = req.params;

    const domainRecord = db.prepare('SELECT * FROM domains WHERE domain = ? AND owner = ?').get(domain, req.agentId) as DomainDbRecord | undefined;
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