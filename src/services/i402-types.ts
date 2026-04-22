// Shared types across the i402 reference implementation.
// i402 v0.1 is agent-side-execution-only — server returns a plan of x402 calls;
// the client (SDK, agent, or any i402-aware runtime) signs and executes them itself.

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
  /** Agent-declared budget ceiling across the session (USDC). */
  budgetUsdc: number;
  /** Kept for historical continuity; not actively updated in agent-side mode. */
  spentUsdc: number;
  /** Kept for historical continuity; zero in agent-side mode. */
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

// -------------------- Plan & Steps --------------------

// In agent-side mode, 'approved' means "plan validated, within budget, ready for
// the client to execute." The status name is retained for DB compatibility.
export type PlanStatus =
  | "awaiting_approval"       // deprecated; kept for DB schema compat
  | "approved"                // plan validated, agent may execute
  | "executing"               // deprecated; kept for DB schema compat
  | "completed"               // agent reported completion
  | "failed"                  // agent reported failure
  | "cancelled"
  | "budget_exceeded"
  | "clarification_needed";

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
  /**
   * The x402 call spec the agent signs + sends itself.
   * `endpoint` is the URL; `method` is HTTP verb; `paymentRail` names the chain.
   */
  x402: {
    endpoint: string;
    method: string;
    paymentRail: PaymentRail;
  };
}

export interface PlanTotals {
  stepCostUsdc: number;
  orchestrationFeeUsdc: number;
  totalCostUsdc: number;
  withinBudget: boolean;
  etaSeconds?: number;
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

// -------------------- Planner input --------------------

export interface PlannerRequest {
  /** Empty string means "resolve by wallet" — see generatePlan. */
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
