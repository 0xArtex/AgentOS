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

export type ServerType = "cx23" | "cx33" | "cx43" | "cx53" | "cpx11" | "cpx21" | "cpx31" | "cpx41" | "cpx51";

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

export const SERVER_PLANS: ServerPlan[] = [
  // Shared vCPU (CX line) — best value
  { type: "cx23",  vcpu: 2,  ram: 4,   disk: 40,  traffic: 20, arch: "x86", hetznerMonthly: 3.49,  priceUsdc: "5.00" },
  { type: "cx33",  vcpu: 4,  ram: 8,   disk: 80,  traffic: 20, arch: "x86", hetznerMonthly: 5.99,  priceUsdc: "9.00" },
  { type: "cx43",  vcpu: 8,  ram: 16,  disk: 160, traffic: 20, arch: "x86", hetznerMonthly: 9.99,  priceUsdc: "15.00" },
  { type: "cx53",  vcpu: 16, ram: 32,  disk: 320, traffic: 20, arch: "x86", hetznerMonthly: 18.99, priceUsdc: "28.00" },
  // Shared vCPU (CPX line) — performance
  { type: "cpx11", vcpu: 2,  ram: 2,   disk: 40,  traffic: 20, arch: "x86", hetznerMonthly: 4.99,  priceUsdc: "7.00" },
  { type: "cpx21", vcpu: 3,  ram: 4,   disk: 80,  traffic: 20, arch: "x86", hetznerMonthly: 9.99,  priceUsdc: "15.00" },
  { type: "cpx31", vcpu: 4,  ram: 8,   disk: 160, traffic: 20, arch: "x86", hetznerMonthly: 17.99, priceUsdc: "26.00" },
  { type: "cpx41", vcpu: 8,  ram: 16,  disk: 240, traffic: 20, arch: "x86", hetznerMonthly: 33.49, priceUsdc: "48.00" },
  { type: "cpx51", vcpu: 16, ram: 32,  disk: 360, traffic: 20, arch: "x86", hetznerMonthly: 66.99, priceUsdc: "95.00" },
];

export const SERVER_PRICING: Record<string, string> = Object.fromEntries(
  SERVER_PLANS.map(p => [p.type, p.priceUsdc])
);

export type ServerAction = "reboot" | "poweron" | "poweroff" | "rebuild" | "reset";

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
