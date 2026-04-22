import crypto from "crypto";
import { db } from "../db";
import type {
  I402Session,
  SessionStatus,
  I402Message,
  MessageRole,
} from "./i402-types";

// -------------------- Row shapes --------------------

interface SessionRow {
  id: string;
  wallet_address: string;
  agent_id: string | null;
  budget_usdc: number;
  spent_usdc: number;
  escrow_usdc: number;
  status: SessionStatus;
  goal_graph: string | null;
  context_summary: string | null;
  created_at: string;
  last_active_at: string;
  expires_at: string | null;
  closed_at: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: MessageRole;
  content: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  llm_cost_usdc: number | null;
  created_at: string;
}

function rowToSession(row: SessionRow): I402Session {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    agentId: row.agent_id ?? undefined,
    budgetUsdc: row.budget_usdc,
    spentUsdc: row.spent_usdc,
    escrowUsdc: row.escrow_usdc,
    status: row.status,
    goalGraph: row.goal_graph ? JSON.parse(row.goal_graph) : undefined,
    contextSummary: row.context_summary ?? undefined,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    expiresAt: row.expires_at ?? undefined,
    closedAt: row.closed_at ?? undefined,
  };
}

function rowToMessage(row: MessageRow): I402Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    model: row.model ?? undefined,
    tokensIn: row.tokens_in ?? undefined,
    tokensOut: row.tokens_out ?? undefined,
    cacheReadTokens: row.cache_read_tokens ?? undefined,
    cacheCreationTokens: row.cache_creation_tokens ?? undefined,
    llmCostUsdc: row.llm_cost_usdc ?? undefined,
    createdAt: row.created_at,
  };
}

// -------------------- Session CRUD --------------------

export interface CreateSessionInput {
  walletAddress: string;
  agentId?: string;
  budgetUsdc: number;
  idleTimeoutHours?: number;
}

export function createSession(input: CreateSessionInput): I402Session {
  const idleTimeout = input.idleTimeoutHours ?? parseInt(process.env.I402_SESSION_IDLE_TIMEOUT_HOURS ?? "24", 10);
  const maxBudget = parseFloat(process.env.I402_SESSION_MAX_BUDGET_USDC ?? "500");

  if (!input.walletAddress) throw new Error("walletAddress is required");
  if (input.budgetUsdc <= 0) throw new Error("budgetUsdc must be positive");
  if (input.budgetUsdc > maxBudget) {
    throw new Error(`budgetUsdc ${input.budgetUsdc} exceeds max ${maxBudget}`);
  }

  const id = `sess_${crypto.randomBytes(8).toString("hex")}`;
  const expiresAt = new Date(Date.now() + idleTimeout * 3600 * 1000).toISOString();

  db.prepare(
    `INSERT INTO i402_agent_sessions (id, wallet_address, agent_id, budget_usdc, spent_usdc, escrow_usdc, status, expires_at)
     VALUES (?, ?, ?, ?, 0, 0, 'active', ?)`
  ).run(id, input.walletAddress, input.agentId ?? null, input.budgetUsdc, expiresAt);

  const session = getSession(id);
  if (!session) throw new Error(`Failed to create session ${id}`);
  return session;
}

export function getSession(id: string): I402Session | undefined {
  const row = db.prepare(`SELECT * FROM i402_agent_sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  return row ? rowToSession(row) : undefined;
}

/**
 * Find the most-recent active session for a wallet. Used by the planner to
 * decide whether an incoming intent should continue an existing session or
 * start a new one.
 */
export function findActiveSessionForWallet(walletAddress: string): I402Session | undefined {
  const row = db
    .prepare(
      `SELECT * FROM i402_agent_sessions
       WHERE wallet_address = ? AND status IN ('active', 'paused')
       ORDER BY last_active_at DESC
       LIMIT 1`
    )
    .get(walletAddress) as SessionRow | undefined;
  return row ? rowToSession(row) : undefined;
}

export function listActiveSessions(walletAddress: string): I402Session[] {
  const rows = db
    .prepare(
      `SELECT * FROM i402_agent_sessions
       WHERE wallet_address = ? AND status IN ('active', 'paused')
       ORDER BY last_active_at DESC`
    )
    .all(walletAddress) as SessionRow[];
  return rows.map(rowToSession);
}

export function touchSession(id: string): void {
  db.prepare(`UPDATE i402_agent_sessions SET last_active_at = datetime('now','utc') WHERE id = ?`).run(id);
}

export function updateSessionStatus(id: string, status: SessionStatus): void {
  const closedAt = ["completed", "cancelled", "expired"].includes(status)
    ? `, closed_at = datetime('now','utc')`
    : "";
  db.prepare(`UPDATE i402_agent_sessions SET status = ?, last_active_at = datetime('now','utc')${closedAt} WHERE id = ?`).run(
    status,
    id
  );
}

export function updateContextSummary(id: string, summary: string): void {
  db.prepare(`UPDATE i402_agent_sessions SET context_summary = ?, last_active_at = datetime('now','utc') WHERE id = ?`).run(
    summary,
    id
  );
}

export function updateGoalGraph(id: string, goalGraph: Record<string, unknown>): void {
  db.prepare(`UPDATE i402_agent_sessions SET goal_graph = ?, last_active_at = datetime('now','utc') WHERE id = ?`).run(
    JSON.stringify(goalGraph),
    id
  );
}

// -------------------- Messages --------------------

export interface AppendMessageInput {
  sessionId: string;
  role: MessageRole;
  content: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  llmCostUsdc?: number;
}

export function appendMessage(input: AppendMessageInput): I402Message {
  const id = `msg_${crypto.randomBytes(6).toString("hex")}`;
  const nextSeqRow = db
    .prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM i402_session_messages WHERE session_id = ?`)
    .get(input.sessionId) as { next: number };
  const seq = nextSeqRow.next;

  db.prepare(
    `INSERT INTO i402_session_messages
       (id, session_id, seq, role, content, model, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, llm_cost_usdc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.sessionId,
    seq,
    input.role,
    input.content,
    input.model ?? null,
    input.tokensIn ?? null,
    input.tokensOut ?? null,
    input.cacheReadTokens ?? null,
    input.cacheCreationTokens ?? null,
    input.llmCostUsdc ?? null
  );
  touchSession(input.sessionId);
  return getMessage(id)!;
}

export function getMessage(id: string): I402Message | undefined {
  const row = db.prepare(`SELECT * FROM i402_session_messages WHERE id = ?`).get(id) as MessageRow | undefined;
  return row ? rowToMessage(row) : undefined;
}

export function listMessages(sessionId: string, limit = 100): I402Message[] {
  const rows = db
    .prepare(`SELECT * FROM i402_session_messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?`)
    .all(sessionId, limit) as MessageRow[];
  return rows.map(rowToMessage);
}

// -------------------- Expiration sweep --------------------

/**
 * Mark expired sessions. Intended to be called periodically by a background task.
 * Returns the IDs that were marked expired.
 */
export function sweepExpiredSessions(): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM i402_agent_sessions
       WHERE status = 'active'
         AND expires_at IS NOT NULL
         AND expires_at < datetime('now','utc')`
    )
    .all() as { id: string }[];

  for (const row of rows) updateSessionStatus(row.id, "expired");
  return rows.map(r => r.id);
}
