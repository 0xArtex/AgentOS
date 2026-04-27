/**
 * Namecheap API client. Extracted from src/routes/domains.ts so other routes
 * (e.g. email inbox provisioning on a wallet-owned domain) can re-use it.
 *
 * The ClientIp constant is the prod server's whitelisted outbound IP — must
 * match the Namecheap account's API IP whitelist or every call 401s.
 */

export interface NamecheapResponse {
  [key: string]: any;
}

export interface DnsHostRecord {
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'URL' | 'URL301';
  name: string;
  value: string;
  ttl?: number;
  mxPref?: number;
}

const NAMECHEAP_CLIENT_IP = process.env.NAMECHEAP_CLIENT_IP || '77.42.89.233';

export async function namecheapRequest(
  command: string,
  params: Record<string, string> = {}
): Promise<NamecheapResponse> {
  const apiUser = process.env.NAMECHEAP_API_USER;
  const apiKey = process.env.NAMECHEAP_API_KEY;

  if (!apiUser || !apiKey) {
    throw new Error('Namecheap API credentials not configured');
  }

  const allParams = {
    ApiUser: apiUser,
    ApiKey: apiKey,
    UserName: apiUser,
    ClientIp: NAMECHEAP_CLIENT_IP,
    Command: command,
    ...params,
  };

  const url = new URL('https://api.namecheap.com/xml.response');
  Object.entries(allParams).forEach(([key, value]) => url.searchParams.append(key, value));

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });
  } catch (error: any) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new Error(`Namecheap API timeout: ${command}`);
    }
    throw new Error(`Namecheap API request failed: ${error?.message ?? String(error)}`);
  }

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

  const xmlText = await response.text();
  const result: NamecheapResponse = { raw: xmlText };

  if (xmlText.includes('<Status>ERROR</Status>')) {
    const errorMatch = xmlText.match(/<Error Number="(\d+)">(.*?)<\/Error>/);
    throw new Error(errorMatch ? errorMatch[2] : 'Namecheap API error');
  }

  // Command-specific parsing kept inline — same shapes that domains.ts has
  // depended on historically.

  if (command === 'namecheap.domains.check') {
    const rows: Array<{ domain: string; available: boolean; premium: boolean }> = [];
    const rx = /<DomainCheckResult\s+([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(xmlText)) !== null) {
      const attrs = m[1];
      const d = attrs.match(/Domain="([^"]*)"/);
      const a = attrs.match(/Available="([^"]*)"/);
      const p = attrs.match(/IsPremiumName="([^"]*)"/);
      if (d && a) {
        rows.push({
          domain: d[1],
          available: a[1].toLowerCase() === 'true',
          premium: (p?.[1] || '').toLowerCase() === 'true',
        });
      }
    }
    result.results = rows;
    if (rows[0]) {
      result.domain = rows[0].domain;
      result.available = rows[0].available;
      result.isPremiumName = rows[0].premium;
    }
  }

  if (command === 'namecheap.users.getPricing') {
    const priceMatches = xmlText.matchAll(/<ProductType Name="DOMAIN".*?<ProductCategory Name="REGISTER".*?<Product Name="([^"]*)".*?<Price Duration="1" DurationType="YEAR" Price="([^"]*)".*?\/>/g);
    result.pricing = {};
    for (const match of priceMatches) {
      result.pricing[match[1]] = parseFloat(match[2]);
    }
  }

  if (command === 'namecheap.domains.create') {
    const tagMatch = xmlText.match(/<DomainCreateResult\s+([^>]*?)\/?>/);
    if (tagMatch) {
      const attrs = tagMatch[1];
      const attr = (name: string): string | null => {
        const mm = attrs.match(new RegExp(`${name}="([^"]*)"`));
        return mm ? mm[1] : null;
      };
      const registered = (attr('Registered') || '').toLowerCase() === 'true';
      const orderId = attr('OrderID');
      result.registered = registered;
      result.orderId = orderId || undefined;
      result.chargedAmount = attr('ChargedAmount');
      result.success = registered && !!orderId;
    }
  }

  if (command === 'namecheap.users.getBalances') {
    const balMatch = xmlText.match(/AvailableBalance="([^"]+)"/);
    if (balMatch) result.availableBalance = parseFloat(balMatch[1]);
  }

  if (command === 'namecheap.domains.dns.getHosts') {
    result.hosts = [];
    const hostMatches = xmlText.matchAll(/<host HostId="[^"]*" Name="([^"]*)" Type="([^"]*)" Address="([^"]*)" MXPref="([^"]*)" TTL="([^"]*)".*?\/>/g);
    for (const match of hostMatches) {
      result.hosts.push({
        name: match[1],
        type: match[2],
        address: match[3],
        mxPref: match[4],
        ttl: match[5],
      });
    }
  }

  if (command === 'namecheap.domains.getInfo') {
    const expiresMatch = xmlText.match(/<DomainDetails.*?<DomainNameservers>.*?<\/DomainNameservers>.*?<\/DomainDetails>.*?<DnsDetails>.*?<\/DnsDetails>.*?<Whoisguard.*?ExpiredDate="([^"]*)".*?\/>/);
    if (expiresMatch) result.expiresAt = expiresMatch[1];
  }

  return result;
}

/**
 * Set DNS records on a wallet-owned domain via Namecheap setHosts. Replaces
 * the entire host list each call (Namecheap's API is non-incremental); pass
 * the full intended record set, not a delta.
 */
export async function setDomainDnsRecords(
  domain: string,
  records: DnsHostRecord[]
): Promise<void> {
  const parts = domain.split('.');
  if (parts.length < 2) throw new Error(`Invalid domain: ${domain}`);
  const sld = parts[0];
  const tld = parts.slice(1).join('.');

  const hosts = records.reduce<Record<string, string>>((acc, r, i) => {
    const n = i + 1;
    acc[`HostName${n}`] = r.name;
    acc[`RecordType${n}`] = r.type;
    acc[`Address${n}`] = r.value;
    acc[`TTL${n}`] = String(r.ttl ?? 1800);
    if (r.type === 'MX') acc[`MXPref${n}`] = String(r.mxPref ?? 10);
    return acc;
  }, {});

  await namecheapRequest('namecheap.domains.dns.setHosts', { SLD: sld, TLD: tld, ...hosts });
}
