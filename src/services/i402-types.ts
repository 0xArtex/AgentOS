// Shared types across the i402 reference implementation.
// Public protocol wire-format types live here alongside internal representations.

import type { I402Provider, I402Quality } from "./i402-providers";

// -------------------- Session --------------------

export type SessionStatus =
  | "active"
  | "paused"
  | "completed"
  | "cancelled"
  | "budget_exhausted"
  | "expired";

export interface I402Session {
  id: string;
  walletAddress: string;
  agentId?: string;
  budgetUsdc: number;
  spentUsdc: number;
  escrowUsdc: number;
  status: SessionStatus;
  goalGraph?: Record<string, unknown>;
  contextSummary?: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt?: string;
  closedAt?: string;
}

export type MessageRole = "agent" | "orchestrator" | "tool" | "clarification" | "system";

export interface I402Message {
  id: string;
  sessionId: string;
  seq: number;
  role: MessageRole;
  content: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  llmCostUsdc?: number;
  createdAt: string;
}

export interface I402Artifact {
  id: string;
  sessionId: string;
  planId?: string;
  stepId?: string;
  type: string;
  name?: string;
  resourceRef: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// -------------------- Plan & Steps --------------------

export type PlanStatus =
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exceeded"
  | "clarification_needed";

export type ExecutionMode = "server_side" | "agent_side" | "hybrid";

export type StepStatus = "pending" | "running" | "ok" | "error" | "timeout" | "skipped" | "cancelled";

export type PaymentRail = "x402-solana" | "x402-base";

export interface PlanStep {
  stepId: string;
  capability: string;
  provider: string;
  description?: string;
  input: Record<string, unknown>;
  inputSchemaRef?: string;
  outputSchemaRef?: string;
  costUsdc: number;
  etaSeconds?: number;
  dependsOn?: string[];
  x402: {
    endpoint: string;
    method: string;
    paymentRail: PaymentRail | "internal";
  };
}

export interface PlanTotals {
  stepCostUsdc: number;
  orchestrationFeeUsdc: number;
  totalCostUsdc: number;
  withinBudget: boolean;
  etaSeconds?: number;
  executionModes: ExecutionMode[];
}

export interface Plan {
  sessionId: string;
  planId: string;
  status: PlanStatus;
  intent: {
    original: string;
    interpreted?: string;
  };
  steps: PlanStep[];
  totals: PlanTotals;
  approval?: {
    required: boolean;
    expiresAt: string;
    hint?: string;
    approveBody: Record<string, unknown>;
  };
}

export interface ClarificationQuestion {
  id: string;
  text: string;
}

export interface ClarificationResponse {
  sessionId: string;
  status: "clarification_needed";
  questions: ClarificationQuestion[];
}

export type PlanOrClarification = Plan | ClarificationResponse;

export function isPlan(result: PlanOrClarification): result is Plan {
  return (result as Plan).planId !== undefined;
}

// -------------------- Step execution results --------------------

export interface StepResult {
  planId: string;
  stepId: string;
  sessionId: string;
  capability: string;
  providerId: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  status: StepStatus;
  latencyMs?: number;
  costChargedUsdc: number;
  retryCount: number;
  x402TxSignature?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

// -------------------- Escrow ledger --------------------

export type EscrowKind = "deposit" | "debit_step" | "debit_orchestration_fee" | "refund";

export interface EscrowLedgerEntry {
  id: string;
  sessionId: string;
  planId?: string;
  stepId?: string;
  kind: EscrowKind;
  amountUsdc: number;
  balanceAfterUsdc: number;
  txSignature?: string;
  chain?: "solana" | "base";
  notes?: string;
  createdAt: string;
}

// -------------------- Planner request/response --------------------

export interface PlannerRequest {
  sessionId: string;
  walletAddress: string;
  intent: string;
  params?: Record<string, unknown>;
  budgetUsdc: number;
  deadlineSeconds?: number;
  quality?: I402Quality;
  constraints?: {
    excludeCapabilities?: string[];
    excludeProviders?: string[];
    requireProviders?: string[];
  };
  approve?: boolean;
  autoApproveUnderUsdc?: number;
}

// -------------------- LLM wrapper --------------------

export interface LLMUsage {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsdc: number;
}

export interface LLMResponse<T = string> {
  model: string;
  content: T;
  usage: LLMUsage;
  stopReason?: string;
}

// -------------------- Re-exports --------------------

export type { I402Provider, I402Quality };
