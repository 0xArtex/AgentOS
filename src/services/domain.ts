import { v4 as uuid } from "uuid";
import { config } from "../config";
import { Domain, DnsRecord } from "../types";
import { storage } from "./storage";

// ── Registrar Interface ───────────────────────────────────────

interface RegistrarProvider {
  register(name: string, tld: string): Promise<{ success: boolean; expiresAt: string }>;
  setDnsRecords(domain: string, records: DnsRecord[]): Promise<{ success: boolean }>;
  getStatus(domain: string): Promise<{ status: "active" | "pending" | "expired" | "failed" }>;
}

// ── Namecheap Stub ────────────────────────────────────────────

class NamecheapProvider implements RegistrarProvider {
  private apiKey = config.namecheapApiKey;
  private apiUser = config.namecheapApiUser;

  async register(name: string, tld: string) {
    if (!this.apiKey) throw new Error("Namecheap API key not configured");
    // TODO: Call Namecheap API — https://www.namecheap.com/support/api/methods/
    // POST https://api.namecheap.com/xml.response?ApiUser=...&ApiKey=...&Command=namecheap.domains.create
    console.log(`[domain] Namecheap: registering ${name}.${tld}`);
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    return { success: true, expiresAt };
  }

  async setDnsRecords(domain: string, records: DnsRecord[]) {
    if (!this.apiKey) throw new Error("Namecheap API key not configured");
    console.log(`[domain] Namecheap: setting ${records.length} DNS records for ${domain}`);
    return { success: true };
  }

  async getStatus(domain: string) {
    console.log(`[domain] Namecheap: checking status for ${domain}`);
    return { status: "active" as const };
  }
}

// ── Cloudflare Stub ───────────────────────────────────────────

class CloudflareProvider implements RegistrarProvider {
  private apiToken = config.cloudflareApiToken;

  async register(name: string, tld: string) {
    if (!this.apiToken) throw new Error("Cloudflare API token not configured");
    // TODO: Call Cloudflare Registrar API — https://developers.cloudflare.com/registrar/
    console.log(`[domain] Cloudflare: registering ${name}.${tld}`);
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    return { success: true, expiresAt };
  }

  async setDnsRecords(domain: string, records: DnsRecord[]) {
    if (!this.apiToken) throw new Error("Cloudflare API token not configured");
    console.log(`[domain] Cloudflare: setting ${records.length} DNS records for ${domain}`);
    return { success: true };
  }

  async getStatus(domain: string) {
    console.log(`[domain] Cloudflare: checking status for ${domain}`);
    return { status: "active" as const };
  }
}

// ── Provider Selection ────────────────────────────────────────

function getProvider(): RegistrarProvider {
  const registrar = config.domainRegistrar;
  if (registrar === "cloudflare") return new CloudflareProvider();
  return new NamecheapProvider();
}

// ── Public API ────────────────────────────────────────────────

/**
 * Register a new domain.
 * Cost: 10.00 USDC
 */
export async function register(
  name: string,
  tld: string,
  owner: string
): Promise<Domain> {
  const fqdn = `${name}.${tld}`;

  // Check if already registered
  if (storage.findDomainByName(fqdn)) {
    throw new Error(`Domain ${fqdn} is already registered`);
  }

  const provider = getProvider();
  const result = await provider.register(name, tld);

  if (!result.success) {
    throw new Error(`Failed to register ${fqdn}`);
  }

  const domain: Domain = {
    id: uuid(),
    domain: fqdn,
    tld,
    owner,
    status: "active",
    registrar: config.domainRegistrar as "namecheap" | "cloudflare",
    dnsRecords: [],
    registeredAt: new Date().toISOString(),
    expiresAt: result.expiresAt,
  };

  storage.setDomain(domain.id, domain);
  return domain;
}

/**
 * Configure DNS records for a domain.
 * Cost: 0.10 USDC
 */
export async function configureDNS(
  domainId: string,
  records: DnsRecord[]
): Promise<Domain> {
  const domain = storage.getDomain(domainId);
  if (!domain) throw new Error(`Domain ${domainId} not found`);
  if (domain.status !== "active") throw new Error("Domain is not active");

  const provider = getProvider();
  const result = await provider.setDnsRecords(domain.domain, records);

  if (!result.success) {
    throw new Error(`Failed to update DNS for ${domain.domain}`);
  }

  domain.dnsRecords = records;
  storage.setDomain(domainId, domain);
  return domain;
}

/**
 * Get domain status.
 */
export async function getStatus(domainId: string): Promise<Domain> {
  const domain = storage.getDomain(domainId);
  if (!domain) throw new Error(`Domain ${domainId} not found`);

  // Optionally refresh from provider
  const provider = getProvider();
  const result = await provider.getStatus(domain.domain);
  domain.status = result.status;
  storage.setDomain(domainId, domain);

  return domain;
}
