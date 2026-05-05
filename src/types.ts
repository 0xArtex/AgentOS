import { Request } from "express";

// ── x402 Payment ──────────────────────────────────────────────

export interface PaymentProof {
  /** Solana transaction signature */
  signature: string;
  /** Payer wallet address */
  payer: string;
  /** Amount in USDC (6 decimals) */
  amountLamports: bigint;
  /** Unix timestamp of verification */
  verifiedAt: number;
}

export interface AuthenticatedRequest extends Request {
  payment?: PaymentProof;
  agentId?: string;
  isHackathonMode?: boolean;
  /** Populated by the i402 session middleware when X-Session-Id is present and valid. */
  i402Session?: import("./services/i402-types").I402Session;
}

// ── Phone Service ─────────────────────────────────────────────

export interface PhoneNumber {
  id: string;
  phoneNumber: string;
  country: string;
  /** Payer wallet that provisioned this number */
  owner: string;
  provisionedAt: string;
  active: boolean;
}

export interface SmsMessage {
  id: string;
  phoneNumberId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  body: string;
  timestamp: string;
}

export interface ProvisionNumberRequest {
  country: string;
  areaCode?: string;
}

export interface SendSmsRequest {
  to: string;
  body: string;
}

// ── Email Service ─────────────────────────────────────────────

export interface EmailInbox {
  id: string;
  address: string;
  /** e.g. "agent-name" portion of agent-name@agntos.dev */
  localPart: string;
  owner: string;
  /** X25519 public key derived from Solana wallet (base64) */
  publicKey: string;
  /** Solana Ed25519 public key (base58) — the wallet that owns this inbox */
  solanaPublicKey: string;
  /** If true, messages are encrypted with wallet key (E2E) — server can't read */
  e2eEnabled?: boolean;
  createdAt: string;
  active: boolean;
}

export interface EmailMessage {
  id: string;
  inboxId: string;
  threadId?: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  cc?: string;
  replyTo?: string;
  messageId?: string;
  inReplyTo?: string;
  /** Encrypted with inbox's X25519 public key (base64) */
  subject: string;
  /** Encrypted with inbox's X25519 public key (base64) */
  body: string;
  html?: string;
  attachments?: EmailAttachment[];
  /** Whether content is E2E encrypted */
  encrypted: boolean;
  timestamp: string;
}

export interface EmailAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  /** base64-encoded content (E2E encrypted if inbox has e2eEnabled) */
  content?: string;
}

export interface EmailThread {
  id: string;
  inboxId: string;
  subject: string;
  participants: string[];
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

export interface CreateInboxRequest {
  /** Desired local part — becomes {name}@mail.agentos.dev */
  name: string;
}

export interface SendEmailRequest {
  to: string;
  subject: string;
  body: string;
  html?: string;
  /** Agent's private key to prove inbox ownership */
  privateKey: string;
}

// ── Domain Service ────────────────────────────────────────────

export interface Domain {
  id: string;
  domain: string;
  tld: string;
  owner: string;
  status: "pending" | "active" | "failed" | "expired";
  registrar: "namecheap" | "cloudflare";
  dnsRecords: DnsRecord[];
  registeredAt: string;
  expiresAt: string;
}

export interface DnsRecord {
  type: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV";
  name: string;
  value: string;
  ttl: number;
  priority?: number;
}

export interface RegisterDomainRequest {
  name: string;
  tld: string;
}

export interface UpdateDnsRequest {
  records: DnsRecord[];
}

// ── Compute Service ───────────────────────────────────────────

// Server-type names are sourced live from Hetzner Cloud at boot
// (src/services/hcloud-types.ts) so we never hardcode a list that gets
// deprecated. Type-level it's just a string; the runtime registry validates.
export type ServerType = string;

export interface ServerPlan {
  type: ServerType;
  vcpu: number;
  ram: number;       // GB
  disk: number;      // GB
  traffic: number;   // TB included
  arch: "x86" | "arm";
  hetznerMonthly: number;  // EUR approx
  priceUsdc: string;       // what we charge
}

// Server-type plans + pricing are sourced LIVE from Hetzner — see
// src/services/hcloud-types.ts. Call `getServerPlans()` / `getServerPricing()`
// to read the current cached list (refreshed every 6h from
// GET /v1/server_types). The old static `SERVER_PLANS` / `SERVER_PRICING`
// constants were removed because they hardcoded types that get deprecated.

export type ServerAction = "reboot" | "poweron" | "poweroff" | "rebuild" | "reset" | "reset_password" | "request_console";

export interface Server {
  id: string;
  name: string;
  serverType: ServerType;
  image: string;
  status: string;
  ipv4: string | null;
  ipv6: string | null;
  owner: string;
  priceMonthly: string;
  createdAt: string;
  rootPassword: string | null;
}

// ── API Key Service ───────────────────────────────────────────

export type ApiKeyProvider = "brave_search" | "helius" | "openai" | "anthropic" | "elevenlabs" | "custom";

export const API_KEY_PRICING: Record<ApiKeyProvider, string> = {
  brave_search: "1.00",
  helius: "2.00",
  openai: "1.00",
  anthropic: "1.00",
  elevenlabs: "1.00",
  custom: "0.50",
};

export interface ApiKey {
  id: string;
  provider: ApiKeyProvider;
  label: string;
  secret: string;
  owner: string;
  priceUsdc: string;
  active: boolean;
  createdAt: string;
}

// ── Pricing ───────────────────────────────────────────────────

export interface PricingTier {
  service: string;
  action: string;
  /** USDC cost (human-readable, e.g. "1.00") */
  priceUsdc: string;
}
