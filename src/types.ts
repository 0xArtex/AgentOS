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
  /** e.g. "agent-name" portion of agent-name@mail.agentos.dev */
  localPart: string;
  owner: string;
  createdAt: string;
  active: boolean;
}

export interface EmailMessage {
  id: string;
  inboxId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  subject: string;
  body: string;
  html?: string;
  timestamp: string;
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
}

// ── Pricing ───────────────────────────────────────────────────

export interface PricingTier {
  service: string;
  action: string;
  /** USDC cost (human-readable, e.g. "1.00") */
  priceUsdc: string;
}
