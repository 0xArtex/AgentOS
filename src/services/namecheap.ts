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

// Default per-request timeout. Short enough to stay under edge timeouts
// (Cloudflare 100s / nginx 60s) for the read/preflight calls that run INSIDE an
// HTTP request. The money-moving `domains.create` runs in a background worker
// and overrides this with a much longer budget (see REGISTRAR_CREATE_TIMEOUT_MS
// in domain-registration.ts): a slow-but-successful registration that trips a
// short client timeout looks like a failure and risks refunding a domain we
// actually bought.
const DEFAULT_NAMECHEAP_TIMEOUT_MS = 10000;

export interface NamecheapRequestOptions {
  /** Override the request timeout. Used by the background registration worker. */
  timeoutMs?: number;
}

/**
 * Throw unless the response is a Namecheap envelope reporting success.
 *
 * Namecheap reports failure as an ATTRIBUTE on the envelope —
 * `<ApiResponse Status="ERROR">` with the reason in `<Errors><Error Number=…>` —
 * and never emits the `<Status>ERROR</Status>` ELEMENT this used to look for.
 * That check could not fire, so every registrar error resolved as a success
 * with no parsed fields, and each caller quietly read its own meaning into the
 * empty object:
 *
 *   • `isOwnedAtRegistrar` returns `true` on resolve ⇒ EVERY domain looked like
 *     ours. A registration that threw was reconciled as "we own it": job marked
 *     active, registry row written, no refund — for a domain that does not
 *     exist. That is exactly how joingrange.xyz cost a payer 2.23 USDC.
 *   • `dns.getHosts` ⇒ `hosts` undefined ⇒ an empty record set, indistinguishable
 *     from a zone with no records.
 *   • `dns.setHosts` ⇒ nothing to inspect ⇒ "DNS records updated successfully"
 *     while the registrar rejected the write.
 *
 * So: succeed only on an explicit `Status="OK"` with no `<Error>` entries.
 * Anything else — an error envelope, an HTML error page, a truncated body —
 * throws, and callers' existing try/catch paths handle it correctly.
 */
export function assertNamecheapOk(command: string, xmlText: string): void {
  const status = (xmlText.match(/<ApiResponse[^>]*\bStatus="([^"]*)"/i) || [])[1];
  // `<Errors />` (the empty element on a success response) deliberately does not
  // match `<Error\b` — the boundary stops it.
  const errors = [...xmlText.matchAll(/<Error\b([^>]*)>([^<]*)<\/Error>/g)]
    .map(m => {
      const number = (m[1].match(/Number="(\d+)"/) || [])[1];
      const message = m[2].trim();
      return number ? `${message} (Namecheap error ${number})` : message;
    })
    .filter(s => s.trim().length > 0);

  if (errors.length > 0) {
    throw new Error(`Namecheap ${command} failed: ${errors.join('; ')}`);
  }
  if ((status || '').toUpperCase() === 'OK') return;
  if (status) {
    throw new Error(`Namecheap ${command} failed: response status ${status}`);
  }
  // Legacy element form, kept so a hypothetical alternate shape still fails closed.
  if (xmlText.includes('<Status>ERROR</Status>')) {
    throw new Error(`Namecheap ${command} failed: error status`);
  }
  throw new Error(
    `Namecheap ${command} failed: unrecognized response (no ApiResponse status) — first 200 chars: ${xmlText.slice(0, 200)}`,
  );
}

export async function namecheapRequest(
  command: string,
  params: Record<string, string> = {},
  opts: NamecheapRequestOptions = {}
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
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_NAMECHEAP_TIMEOUT_MS),
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

  assertNamecheapOk(command, xmlText);

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
    // Positive ownership evidence for the reconciliation oracle, so it can
    // assert on a named domain instead of on "the call didn't throw".
    const info = xmlText.match(/<DomainGetInfoResult\b([^>]*)>/i);
    if (info) {
      const attr = (name: string): string | undefined =>
        (info[1].match(new RegExp(`\\b${name}="([^"]*)"`, 'i')) || [])[1];
      result.domainName = attr('DomainName');
      result.infoStatus = attr('Status');
      const owner = attr('IsOwner');
      if (owner !== undefined) result.isOwner = owner.toLowerCase() === 'true';
    }
  }

  if (command === 'namecheap.domains.dns.setHosts') {
    // A zone write can come back Status="OK" with IsSuccess="false" — the call
    // was well-formed, the update didn't happen. Surface that as a failure, or
    // the route reports "DNS records updated successfully" for a no-op.
    const ok = xmlText.match(/<DomainDNSSetHostsResult[^>]*\bIsSuccess="([^"]*)"/i);
    if (ok) {
      result.isSuccess = ok[1].toLowerCase() === 'true';
      if (!result.isSuccess) {
        throw new Error(`Namecheap ${command} failed: registrar reported IsSuccess=false`);
      }
    }
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

  // Namecheap's default mail mode for a freshly-registered domain is "FWD"
  // (their email-forwarding service via eforward1-5.registrar-servers.com).
  // While in FWD/MXE mode, custom MX records sent via setHosts are silently
  // ignored — the dashboard accepts the call but DNS keeps serving the
  // eforward MX list. Switching EmailType to "MX" tells Namecheap to honor
  // the host-level MX rows we just sent. Only set it when the caller actually
  // included MX records, so we don't clobber Gmail/Workspace setups for
  // domains that don't need custom MX.
  const hasMx = records.some(r => r.type === 'MX');
  const params: Record<string, string> = { SLD: sld, TLD: tld, ...hosts };
  if (hasMx) params.EmailType = 'MX';

  await namecheapRequest('namecheap.domains.dns.setHosts', params);
}
