/**
 * Async prepaid-card purchases (Laso Finance upstream, per-agent accounts).
 *
 * Modeled on domain-registration.ts — the money-moving, non-idempotent,
 * externally-side-effecting job class: the agent's USDC settles to our
 * treasury BEFORE the handler runs, then WE spend real USDC upstream buying
 * the card. A blind retry buys two cards; a blind refund gives back money for
 * a card that exists. Every ambiguous path therefore reconciles against two
 * oracles instead of guessing:
 *
 *   1. authorizationConsumed(payer, nonce) — the on-chain EIP-3009 state on
 *      Base USDC. We persist the payment nonce (and the payer address) BEFORE
 *      the paid request goes out, so after any crash we can ask the chain
 *      "did that exact payment move money?". Unused + validBefore expired ⇒
 *      provably never paid ⇒ safe to auto-refund the agent. Consumed ⇒ money
 *      reached Laso ⇒ go find what it bought.
 *   2. Laso's own account state — lasoListCards() on the OWNER'S account
 *      finds an orphaned card a crashed job paid for (adopt it), and the
 *      account balance catches the settled-but-no-card case (Laso credits
 *      unfulfilled charges to the account; withdraw + refund the agent).
 *
 * Per-agent sharding (Laso's guidance, 2026-07-09): every owner buys through
 * its own dedicated payer wallet (services/card-payer-wallets.ts) = its own
 * Laso account. The worker gains a FUNDING step — the operator's float wallet
 * tops the owner's payer wallet up by the shortfall just-in-time. Funding is
 * crash-safe by construction: money only ever moves between wallets WE hold,
 * and shortfall-only top-ups mean a re-run after any partial state converges
 * instead of double-funding. Fund+buy runs under a per-owner lock.
 *
 * Lifecycle: pending → purchasing → provisioning → (ready | failed)
 *   pending      — row exists, upstream untouched (safe to re-run; a funding
 *                  hiccup parks the job back here for the sweep)
 *   purchasing   — payment may have been sent (reconcile only, never re-buy)
 *   provisioning — Laso confirmed the purchase (card_id held); polling for
 *                  PAN/CVV. The card EXISTS: this state never refunds.
 *   ready        — details stored (AES-256-GCM under SECRETS_MASTER_KEY)
 *   failed       — definitive failure; agent auto-refunded (idempotent)
 *
 * Issuance ceilings (rolling 24h, face value): a global cap bounds operator
 * float exposure; a per-agent cap bounds one wallet's velocity. Reservation
 * happens inside a single SQLite transaction so concurrent settles can't
 * oversubscribe the window; the route ALSO checks pre-paywall so the common
 * case is rejected before any USDC moves.
 */
import { randomUUID } from "crypto";
import { db } from "../db";
import { config } from "../config";
import { sealSecret, openSecret } from "./secret-box";
import { refundUsdcToPayer, RefundOpts, RefundResult } from "./refund";
import * as balanceService from "./balance";
import {
  lasoBuyUsCard,
  lasoGetCardData,
  lasoListCards,
  lasoAccountBalance,
  lasoWithdraw,
  getLasoIdToken,
  LasoBuyResult,
  LasoCardData,
  LasoDeclinedError,
} from "./laso";
import {
  payerAuthCtx,
  payerAddressFor,
  ensurePayerFunded,
  clearPayerTokens,
  withOwnerLock,
  CardFundingError,
  EnsureFundedResult,
} from "./card-payer-wallets";
import { authorizationConsumed } from "./x402-client";

const DASHBOARD_OWNER_PREFIX = "dashboard:";
function dashboardUserId(owner: string): string | null {
  return owner.startsWith(DASHBOARD_OWNER_PREFIX) ? owner.slice(DASHBOARD_OWNER_PREFIX.length) : null;
}

export type CardPurchaseStatus = "pending" | "purchasing" | "provisioning" | "ready" | "failed";

export interface CardPurchaseRow {
  id: string;
  owner: string;
  payment_signature: string | null;
  payment_chain: "solana" | "base" | null;
  charged_usdc: number | null;
  card_usd: number;
  fee_usdc: number;
  status: CardPurchaseStatus;
  laso_card_id: string | null;
  laso_user_id: string | null;
  upstream_paid_usdc: number | null;
  payment_nonce: string | null;
  payment_valid_before: number | null;
  payer_address: string | null;
  funding_tx: string | null;
  card_ciphertext: string | null;
  last4: string | null;
  available_balance: number | null;
  error: string | null;
  error_code: string | null;
  refund_id: string | null;
  refund_status: string | null;
  created_at: string;
  started_at: string | null;
  ready_at: string | null;
  completed_at: string | null;
}

// ─── Schema (self-registered, domain-registration pattern) ───
db.exec(`
  CREATE TABLE IF NOT EXISTS card_purchases (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    payment_signature TEXT,
    payment_chain TEXT,
    charged_usdc REAL,
    card_usd REAL NOT NULL,
    fee_usdc REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','purchasing','provisioning','ready','failed')),
    laso_card_id TEXT,
    laso_user_id TEXT,
    upstream_paid_usdc REAL,
    payment_nonce TEXT,
    payment_valid_before INTEGER,
    payer_address TEXT,
    funding_tx TEXT,
    card_ciphertext TEXT,
    last4 TEXT,
    available_balance REAL,
    error TEXT,
    error_code TEXT,
    refund_id TEXT,
    refund_status TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    ready_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_card_purchases_owner ON card_purchases(owner);
  CREATE INDEX IF NOT EXISTS idx_card_purchases_status ON card_purchases(status);
  CREATE INDEX IF NOT EXISTS idx_card_purchases_created ON card_purchases(created_at);
`);
// Pre-sharding dev DBs created the table without the per-agent columns.
{
  const cols = db.prepare("PRAGMA table_info(card_purchases)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "payer_address")) db.exec("ALTER TABLE card_purchases ADD COLUMN payer_address TEXT");
  if (!cols.some((c) => c.name === "funding_tx")) db.exec("ALTER TABLE card_purchases ADD COLUMN funding_tx TEXT");
}

const nowIso = () => new Date().toISOString();

// ─── Pricing ───

/** Palmyr fee on top of the card's face value: max(pct·amount, min), in cents. */
export function cardFeeUsdc(cardUsd: number): number {
  const pct = config.lasoCardFeePct;
  const min = config.lasoCardFeeMinUsdc;
  return Math.max(Math.round(cardUsd * pct * 100) / 100, min);
}

/** Total x402 price the agent pays. 2dp — price·1e6 stays integral. */
export function cardPriceUsdc(cardUsd: number): number {
  return Math.round((cardUsd + cardFeeUsdc(cardUsd)) * 100) / 100;
}

/** Valid card amount: finite, integral cents, within the configured bounds. */
export function validCardAmount(amount: unknown): amount is number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return false;
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return false;
  return amount >= config.lasoMinCardUsd && amount <= config.lasoMaxCardUsd;
}

// ─── Issuance ceilings (rolling 24h) ───

export interface CardLimitStatus {
  ok: boolean;
  code: "daily_global" | "daily_agent" | "daily_agent_cards" | null;
  globalUsedUsd: number;
  agentUsedUsd: number;
  globalMaxUsd: number;
  agentMaxUsd: number;
  agentUsedCards: number;
  agentMaxCards: number;
}

function window24hCutoff(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Would a purchase of `cardUsd` by `owner` fit the rolling-24h ceilings?
 * Failed rows don't count (the agent was refunded, no lasting exposure);
 * everything else — including in-flight reservations — does.
 *
 * Three ceilings: global dollars (operator float exposure), per-agent dollars
 * (velocity), and per-agent CARD COUNT — the last mirrors Laso's confirmed
 * per-wallet limit of 6 cards/day (each agent is its own wallet upstream, so
 * exceeding it would just make Laso decline that agent's 7th card anyway).
 */
export function checkCardLimits(owner: string, cardUsd: number): CardLimitStatus {
  const cutoff = window24hCutoff();
  const globalUsed = (db
    .prepare("SELECT COALESCE(SUM(card_usd), 0) AS s FROM card_purchases WHERE created_at > ? AND status != 'failed'")
    .get(cutoff) as any).s as number;
  const agent = db
    .prepare(
      "SELECT COALESCE(SUM(card_usd), 0) AS s, COUNT(*) AS c FROM card_purchases WHERE created_at > ? AND status != 'failed' AND owner = ?"
    )
    .get(cutoff, owner) as any;
  const agentUsed = agent.s as number;
  const agentCards = agent.c as number;

  const status: CardLimitStatus = {
    ok: true,
    code: null,
    globalUsedUsd: globalUsed,
    agentUsedUsd: agentUsed,
    globalMaxUsd: config.lasoDailyMaxUsd,
    agentMaxUsd: config.lasoAgentDailyMaxUsd,
    agentUsedCards: agentCards,
    agentMaxCards: config.lasoAgentDailyMaxCards,
  };
  if (globalUsed + cardUsd > config.lasoDailyMaxUsd) {
    status.ok = false;
    status.code = "daily_global";
  } else if (agentUsed + cardUsd > config.lasoAgentDailyMaxUsd) {
    status.ok = false;
    status.code = "daily_agent";
  } else if (agentCards + 1 > config.lasoAgentDailyMaxCards) {
    status.ok = false;
    status.code = "daily_agent_cards";
  }
  return status;
}

export class CardLimitError extends Error {
  constructor(public limit: CardLimitStatus) {
    super(
      limit.code === "daily_agent_cards"
        ? `Per-agent 24h card COUNT limit reached (${limit.agentUsedCards}/${limit.agentMaxCards} cards — issuer allows ${limit.agentMaxCards}/day per account)`
        : limit.code === "daily_agent"
          ? `Per-agent 24h card issuance limit reached ($${limit.agentUsedUsd}/$${limit.agentMaxUsd} used)`
          : `Global 24h card issuance limit reached ($${limit.globalUsedUsd}/$${limit.globalMaxUsd} used)`
    );
    this.name = "CardLimitError";
  }
}

// ─── Dependency injection (testability — every oracle/side-effect is a dep) ───

export interface CardPurchaseDeps {
  /** Top the owner's payer wallet up to `amountUsd` (shortfall-only). */
  ensureFunded: (owner: string, amountUsd: number) => Promise<EnsureFundedResult>;
  /** Paid upstream purchase from the owner's wallet. onBeforePay persists the nonce pre-send. */
  buyCard: (
    owner: string,
    amountUsd: number,
    onBeforePay: (info: { nonce: string; validBefore: number }) => void | Promise<void>
  ) => Promise<LasoBuyResult>;
  /** Poll one card on the owner's account (auth handled internally; retries once on token rejection). */
  getCardData: (owner: string, lasoCardId: string) => Promise<LasoCardData>;
  /** Reconciliation: every card on the owner's upstream account. */
  listCards: (owner: string) => Promise<LasoCardData[]>;
  /** On-chain oracle: was this exact EIP-3009 authorization redeemed? */
  authorizationConsumed: (payerAddress: string, nonce: string) => Promise<boolean>;
  /** The owner's upstream account balance (settled-but-unfulfilled charges land here). */
  accountBalance: (owner: string) => Promise<number>;
  /** Recover stranded upstream balance to the owner's payer wallet (best-effort). */
  withdraw: (owner: string, amountUsd: number) => Promise<void>;
  /** Refund the agent on definitive failure (idempotent on signature). */
  refund: (opts: RefundOpts) => Promise<RefundResult>;
  /** Dashboard-balance payers get an internal credit instead. */
  refundDashboard: (userId: string, amountUsdc: number, referenceId: string, reason: string) => void;
  /** The owner's payer wallet address (nonce-oracle fallback for legacy rows). */
  payerAddressFor: (owner: string) => string | null;
  /** Poll cadence/budget (tests shrink these). */
  pollIntervalMs?: number;
  pollBudgetMs?: number;
}

function defaultGetCardData(): (owner: string, lasoCardId: string) => Promise<LasoCardData> {
  return async (owner: string, lasoCardId: string) => {
    try {
      return await lasoGetCardData(lasoCardId, await getLasoIdToken(payerAuthCtx(owner)));
    } catch (e: any) {
      if (String(e?.message || "").startsWith("laso_auth_rejected")) {
        // Token went stale mid-loop — force the refresh/SIWX ladder once.
        clearPayerTokens(owner);
        return await lasoGetCardData(lasoCardId, await getLasoIdToken(payerAuthCtx(owner)));
      }
      throw e;
    }
  };
}

export function defaultCardDeps(): CardPurchaseDeps {
  return {
    ensureFunded: (owner, amountUsd) => ensurePayerFunded(owner, amountUsd),
    buyCard: (owner, amountUsd, onBeforePay) => lasoBuyUsCard(payerAuthCtx(owner), amountUsd, onBeforePay),
    getCardData: defaultGetCardData(),
    listCards: async (owner) => lasoListCards(await getLasoIdToken(payerAuthCtx(owner))),
    authorizationConsumed: (payerAddress, nonce) => authorizationConsumed(payerAddress, nonce),
    accountBalance: async (owner) => lasoAccountBalance(await getLasoIdToken(payerAuthCtx(owner))),
    withdraw: async (owner, amountUsd) => {
      await lasoWithdraw(amountUsd, await getLasoIdToken(payerAuthCtx(owner)));
    },
    refund: (opts) => refundUsdcToPayer(opts),
    refundDashboard: (userId, amountUsdc, referenceId, reason) => {
      balanceService.refund(userId, amountUsdc, `card purchase refund: ${reason}`, referenceId);
    },
    payerAddressFor: (owner) => payerAddressFor(owner),
  };
}

// ─── Job CRUD ───

export function getCardPurchase(id: string): CardPurchaseRow | null {
  const row = db.prepare("SELECT * FROM card_purchases WHERE id = ?").get(id) as CardPurchaseRow | undefined;
  return row || null;
}

export interface CreateCardPurchaseInput {
  owner: string;
  paymentSignature: string | null;
  paymentChain: "solana" | "base" | null;
  chargedUsdc: number | null;
  cardUsd: number;
  feeUsdc: number;
}

/**
 * Atomically re-check the ceilings and insert the reservation, then kick the
 * worker. The transaction closes the pre-paywall race: two concurrent settles
 * both passed the advisory check, but only the first fits the window here —
 * the loser throws CardLimitError and the route auto-refunds it.
 */
export function createCardPurchase(
  input: CreateCardPurchaseInput,
  deps: CardPurchaseDeps = defaultCardDeps()
): CardPurchaseRow {
  const id = randomUUID();
  const insert = db.transaction(() => {
    const limit = checkCardLimits(input.owner, input.cardUsd);
    if (!limit.ok) throw new CardLimitError(limit);
    db.prepare(
      `INSERT INTO card_purchases
         (id, owner, payment_signature, payment_chain, charged_usdc, card_usd, fee_usdc, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      id,
      input.owner,
      input.paymentSignature,
      input.paymentChain,
      input.chargedUsdc,
      input.cardUsd,
      input.feeUsdc,
      // ISO-8601 with 'T' so recovery-cutoff comparisons sort correctly
      // against toISOString() (see domain-registration.ts:344).
      nowIso()
    );
  });
  insert();
  scheduleWorker(id, deps);
  return getCardPurchase(id)!;
}

function scheduleWorker(id: string, deps: CardPurchaseDeps): void {
  setImmediate(() => {
    runCardPurchase(id, deps).catch((e) => {
      try {
        db.prepare(
          "UPDATE card_purchases SET error = ?, error_code = 'worker_exception', started_at = COALESCE(started_at, ?) WHERE id = ? AND status IN ('pending','purchasing','provisioning')"
        ).run(String(e?.message || e), nowIso(), id);
      } catch {
        /* recovery sweep will reconcile */
      }
    });
  });
}

// ─── Worker ───

export async function runCardPurchase(jobId: string, deps: CardPurchaseDeps = defaultCardDeps()): Promise<void> {
  const job = getCardPurchase(jobId);
  if (!job) throw new Error(`card_purchase ${jobId} not found`);
  // Only a fresh 'pending' row may engage the upstream. A row a previous
  // process already flipped to 'purchasing' must reconcile, never re-buy.
  if (job.status !== "pending") return;

  db.prepare("UPDATE card_purchases SET status = 'purchasing', started_at = ? WHERE id = ? AND status = 'pending'").run(
    nowIso(),
    jobId
  );

  // Fund + buy under the per-owner lock so two purchases by the same owner
  // can't race the shortfall computation into a double-fund.
  let bought: LasoBuyResult;
  try {
    bought = await withOwnerLock(job.owner, async () => {
      // ── Funding step ──
      let funded: EnsureFundedResult;
      try {
        funded = await deps.ensureFunded(job.owner, job.card_usd);
      } catch (e: any) {
        if (e instanceof CardFundingError && e.definitive) throw e;
        // Non-definitive (RPC hiccup, transfer timeout): the money — if any
        // moved — is in a wallet WE hold, and the next attempt only funds the
        // remaining shortfall. Park back to 'pending' for the sweep.
        const parked: any = new CardFundingError(String(e?.message || e), false);
        throw parked;
      }
      db.prepare("UPDATE card_purchases SET payer_address = ?, funding_tx = COALESCE(?, funding_tx) WHERE id = ?").run(
        funded.address,
        funded.fundingTx,
        jobId
      );

      // ── Purchase step ──
      return deps.buyCard(job.owner, job.card_usd, (info) => {
        // Persist the reconciliation handle BEFORE the payment can reach the
        // wire. If we die after this line, the nonce tells the truth later.
        db.prepare("UPDATE card_purchases SET payment_nonce = ?, payment_valid_before = ? WHERE id = ?").run(
          info.nonce,
          info.validBefore,
          jobId
        );
      });
    });
  } catch (e: any) {
    if (e instanceof CardFundingError) {
      if (e.definitive) {
        // Float wallet missing/insolvent — nothing moved. Definitive.
        const reason = `funding_failed: ${e.message}`;
        markFailed(jobId, "float_insufficient", reason);
        await issueRefund(getCardPurchase(jobId)!, deps, reason);
      } else {
        db.prepare(
          "UPDATE card_purchases SET status = 'pending', error = ?, error_code = 'funding_retry' WHERE id = ? AND status = 'purchasing'"
        ).run(String(e.message), jobId);
      }
      return;
    }
    if (e instanceof LasoDeclinedError) {
      // Probe-level decline: nothing was ever signed. Definitive.
      const reason = `laso_declined: ${e.message}`;
      markFailed(jobId, "laso_declined", reason);
      await issueRefund(getCardPurchase(jobId)!, deps, reason);
      return;
    }
    // Ambiguous (network death / post-payment error). The nonce is already on
    // the row; reconcile now (usually resolves as not-yet-expired → deferred
    // to the sweep) — never blind-refund, never blind-retry.
    console.error("[card-purchases] buy threw — ambiguous, reconciling", {
      jobId,
      error: e?.message || String(e),
    });
    await reconcileCardPurchase(jobId, deps, `buy_threw: ${e?.message || e}`);
    return;
  }

  db.prepare(
    "UPDATE card_purchases SET status = 'provisioning', laso_card_id = ?, laso_user_id = ?, upstream_paid_usdc = ? WHERE id = ?"
  ).run(bought.cardId, bought.lasoUserId, bought.paidUsdc, jobId);

  await pollUntilReady(jobId, deps);
}

/**
 * Poll Laso until the card's PAN/CVV are available (~7-10s typical), then
 * store them encrypted. The card exists from the moment we enter
 * 'provisioning' — a poll timeout NEVER fails/refunds the job; it leaves it
 * for the recovery sweep to resume.
 */
export async function pollUntilReady(jobId: string, deps: CardPurchaseDeps = defaultCardDeps()): Promise<void> {
  const job = getCardPurchase(jobId);
  if (!job || job.status !== "provisioning" || !job.laso_card_id) return;

  const interval = deps.pollIntervalMs ?? 2500;
  const budget = deps.pollBudgetMs ?? 90_000;
  const deadline = Date.now() + budget;

  while (Date.now() < deadline) {
    let data: LasoCardData | null = null;
    try {
      data = await deps.getCardData(job.owner, job.laso_card_id);
    } catch (e: any) {
      console.warn("[card-purchases] poll error (will retry):", e?.message || String(e));
    }
    if (data?.status === "ready" && data.card_details?.card_number) {
      const d = data.card_details;
      const ciphertext = sealSecret(
        JSON.stringify({
          card_number: d.card_number,
          exp_month: d.exp_month,
          exp_year: d.exp_year,
          cvv: d.cvv,
        })
      );
      db.prepare(
        `UPDATE card_purchases
           SET status = 'ready', card_ciphertext = ?, last4 = ?, available_balance = ?, ready_at = ?, completed_at = ?, error = NULL, error_code = NULL
         WHERE id = ? AND status = 'provisioning'`
      ).run(
        ciphertext,
        String(d.card_number).slice(-4),
        typeof d.available_balance === "number" ? d.available_balance : job.card_usd,
        nowIso(),
        nowIso(),
        jobId
      );
      return;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  // Budget exhausted — leave 'provisioning' with a breadcrumb for the sweep.
  db.prepare(
    "UPDATE card_purchases SET error = ?, error_code = 'provisioning_slow' WHERE id = ? AND status = 'provisioning'"
  ).run(`card not ready after ${Math.round(budget / 1000)}s — recovery sweep will resume polling`, jobId);
}

function markFailed(jobId: string, code: string, message: string): void {
  db.prepare("UPDATE card_purchases SET status = 'failed', error = ?, error_code = ?, completed_at = ? WHERE id = ?").run(
    message,
    code,
    nowIso(),
    jobId
  );
}

// Refund the agent for a failed job (idempotent end-to-end — see
// domain-registration.ts issueRefund, which this mirrors).
async function issueRefund(job: CardPurchaseRow, deps: CardPurchaseDeps, reason: string): Promise<void> {
  const dashUser = dashboardUserId(job.owner);
  if (dashUser) {
    if (job.charged_usdc == null || job.charged_usdc <= 0) {
      db.prepare("UPDATE card_purchases SET refund_status = 'manual_needed' WHERE id = ?").run(job.id);
      console.error("[card-purchases] [REFUND NEEDED] dashboard payer with no recorded charge", {
        jobId: job.id,
        owner: job.owner,
      });
      return;
    }
    try {
      deps.refundDashboard(dashUser, job.charged_usdc, job.id, reason);
      db.prepare("UPDATE card_purchases SET refund_status = 'sent' WHERE id = ?").run(job.id);
    } catch (e: any) {
      db.prepare("UPDATE card_purchases SET refund_status = 'failed' WHERE id = ?").run(job.id);
      console.error("[card-purchases] dashboard refund threw", { jobId: job.id, error: e?.message || String(e) });
    }
    return;
  }

  if (!job.payment_signature || !job.payment_chain || job.charged_usdc == null) {
    db.prepare("UPDATE card_purchases SET refund_status = 'manual_needed' WHERE id = ?").run(job.id);
    console.error("[card-purchases] [REFUND NEEDED] missing payment context", {
      jobId: job.id,
      signature: job.payment_signature,
      chain: job.payment_chain,
      amount: job.charged_usdc,
    });
    return;
  }
  try {
    const result = await deps.refund({
      chain: job.payment_chain,
      payer: job.owner,
      amountUsdc: job.charged_usdc,
      originalPaymentSignature: job.payment_signature,
      reason: `card purchase failed: ${reason}`,
      endpoint: "POST /cards/buy",
    });
    db.prepare("UPDATE card_purchases SET refund_id = ?, refund_status = ? WHERE id = ?").run(
      result.refundId,
      result.ok ? "sent" : "failed",
      job.id
    );
    if (!result.ok) {
      console.error("[card-purchases] auto-refund deferred (treasury issue)", { jobId: job.id, reason: result.reason });
    }
  } catch (e: any) {
    db.prepare("UPDATE card_purchases SET refund_status = 'failed' WHERE id = ?").run(job.id);
    console.error("[card-purchases] auto-refund threw", { jobId: job.id, error: e?.message || String(e) });
  }
}

// Extra margin past validBefore before declaring an unused authorization dead:
// settlement is checked against block timestamps, so give the chain a couple
// of minutes of skew before refunding on "expired".
const VALID_BEFORE_GRACE_SECONDS = 120;

/**
 * Resolve a 'purchasing' job of unknown upstream outcome.
 *
 * Decision tree (each step is an oracle, never a guess):
 *   laso_card_id on row          → purchase confirmed → provisioning + poll
 *   no nonce on row              → nothing was ever signed → safe re-run
 *   nonce unused + window passed → provably never paid → failed + refund
 *   nonce unused + window open   → still settleable → defer to next sweep
 *   nonce consumed               → money reached the owner's Laso account:
 *       unclaimed upstream card matching amount → adopt → provisioning
 *       account balance ≥ amount → withdraw (best-effort) → failed + refund
 *       neither                  → defer with loud breadcrumb (manual ops)
 */
export async function reconcileCardPurchase(
  jobId: string,
  deps: CardPurchaseDeps = defaultCardDeps(),
  reasonIfFailed = "reconcile",
  opts: { fromRecoverySweep?: boolean } = {}
): Promise<void> {
  const job = getCardPurchase(jobId);
  if (!job || job.status !== "purchasing") return;

  if (job.laso_card_id) {
    db.prepare("UPDATE card_purchases SET status = 'provisioning' WHERE id = ? AND status = 'purchasing'").run(jobId);
    await pollUntilReady(jobId, deps);
    return;
  }

  if (!job.payment_nonce) {
    // onBeforePay never ran → no authorization exists → re-running cannot
    // double-pay (funding, if it partially happened, only shrinks the next
    // shortfall). Reset to pending; only the recovery sweep re-runs (inline
    // callers just leave it for the sweep to avoid tight retry loops).
    db.prepare(
      "UPDATE card_purchases SET status = 'pending', error = ?, error_code = 'retry_never_signed' WHERE id = ? AND status = 'purchasing'"
    ).run(reasonIfFailed, jobId);
    if (opts.fromRecoverySweep) await runCardPurchase(jobId, deps);
    return;
  }

  const payer = job.payer_address || deps.payerAddressFor(job.owner);
  if (!payer) {
    console.error("[card-purchases] reconcile blocked — payer wallet unknown", { jobId, owner: job.owner });
    return;
  }

  let consumed: boolean;
  try {
    consumed = await deps.authorizationConsumed(payer, job.payment_nonce);
  } catch (e: any) {
    console.warn("[card-purchases] nonce oracle unreachable — deferring", { jobId, error: e?.message || String(e) });
    return;
  }

  if (!consumed) {
    const expired =
      job.payment_valid_before != null &&
      Date.now() / 1000 > job.payment_valid_before + VALID_BEFORE_GRACE_SECONDS;
    if (expired) {
      const reason = `payment authorization expired unused (${reasonIfFailed})`;
      markFailed(jobId, "upstream_never_paid", reason);
      await issueRefund(getCardPurchase(jobId)!, deps, reason);
    } else {
      db.prepare("UPDATE card_purchases SET error = ?, error_code = 'reconcile_waiting_expiry' WHERE id = ?").run(
        reasonIfFailed,
        jobId
      );
    }
    return;
  }

  // Money reached the owner's Laso account. Find what it bought.
  let upstreamCards: LasoCardData[];
  try {
    upstreamCards = await deps.listCards(job.owner);
  } catch (e: any) {
    console.warn("[card-purchases] upstream card list unreachable — deferring", { jobId, error: e?.message || String(e) });
    return;
  }

  const claimed = new Set(
    (db.prepare("SELECT laso_card_id FROM card_purchases WHERE laso_card_id IS NOT NULL").all() as any[]).map(
      (r) => r.laso_card_id as string
    )
  );
  const orphan = upstreamCards.find(
    (c) => c.card_id && !claimed.has(String(c.card_id)) && Number(c.usd_amount) === job.card_usd
  );
  if (orphan) {
    // Claim atomically — a sibling reconcile must not adopt the same card.
    const res = db
      .prepare(
        `UPDATE card_purchases SET status = 'provisioning', laso_card_id = ?, upstream_paid_usdc = ?, error = NULL, error_code = NULL
         WHERE id = ? AND status = 'purchasing'
           AND NOT EXISTS (SELECT 1 FROM card_purchases WHERE laso_card_id = ?)`
      )
      .run(String(orphan.card_id), job.card_usd, jobId, String(orphan.card_id));
    if (res.changes === 1) {
      console.log("[card-purchases] adopted orphaned upstream card after crash", {
        jobId,
        lasoCardId: orphan.card_id,
      });
      await pollUntilReady(jobId, deps);
      return;
    }
  }

  // Paid, no card. Laso credits unfulfilled charges to the account balance —
  // recover it to the owner's payer wallet, then make the agent whole.
  let balance: number | null = null;
  try {
    balance = await deps.accountBalance(job.owner);
  } catch {
    balance = null;
  }
  if (balance != null && balance >= job.card_usd - 0.01) {
    try {
      await deps.withdraw(job.owner, job.card_usd);
    } catch (e: any) {
      console.error("[card-purchases] withdraw of stranded balance failed (refunding agent regardless)", {
        jobId,
        error: e?.message || String(e),
      });
    }
    const reason = `upstream settled but no card issued; balance recovered (${reasonIfFailed})`;
    markFailed(jobId, "upstream_settled_no_card", reason);
    await issueRefund(getCardPurchase(jobId)!, deps, reason);
    return;
  }

  // Consumed, no orphan, no balance — needs eyes. Keep reconciling; ops sees the log.
  db.prepare("UPDATE card_purchases SET error = ?, error_code = 'reconcile_unresolved' WHERE id = ?").run(
    `payment consumed but no card/balance found (${reasonIfFailed})`,
    jobId
  );
  console.error("[card-purchases] [RECONCILE UNRESOLVED] payment consumed, nothing to adopt or withdraw", {
    jobId,
    nonce: job.payment_nonce,
  });
}

// ─── Crash recovery ───

const STUCK_AGE_MS = 2 * 60 * 1000;
const RECOVERY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let recoveryInFlight = false;

export async function recoverStuckCardPurchases(deps: CardPurchaseDeps = defaultCardDeps()): Promise<void> {
  if (recoveryInFlight) return;
  recoveryInFlight = true;
  try {
    const cutoff = new Date(Date.now() - STUCK_AGE_MS).toISOString();
    const stuck = db
      .prepare(
        "SELECT * FROM card_purchases WHERE status IN ('pending','purchasing','provisioning') AND created_at < ? ORDER BY created_at ASC"
      )
      .all(cutoff) as CardPurchaseRow[];
    if (stuck.length === 0) return;

    console.log(`[card-purchases] reconciling ${stuck.length} stuck purchase(s)`);
    for (const job of stuck) {
      try {
        if (job.status === "pending") {
          await runCardPurchase(job.id, deps);
        } else if (job.status === "purchasing") {
          await reconcileCardPurchase(job.id, deps, "server_restarted_mid_purchase", { fromRecoverySweep: true });
        } else {
          await pollUntilReady(job.id, deps);
        }
      } catch (e: any) {
        console.error("[card-purchases] recovery pass failed for job", { jobId: job.id, error: e?.message || String(e) });
      }
    }
  } finally {
    recoveryInFlight = false;
  }
}

export function startCardPurchaseRecovery(): void {
  setImmediate(() => {
    recoverStuckCardPurchases().catch((e) =>
      console.error("[card-purchases] startup recovery error:", e?.message || String(e))
    );
  });
  setInterval(() => {
    recoverStuckCardPurchases().catch((e) =>
      console.error("[card-purchases] periodic recovery error:", e?.message || String(e))
    );
  }, RECOVERY_SWEEP_INTERVAL_MS).unref();
}

// ─── Card detail access (owner-verified in the route) ───

export interface DecryptedCardDetails {
  card_number: string;
  exp_month: string;
  exp_year: string;
  cvv: string;
}

export function decryptCardDetails(row: CardPurchaseRow): DecryptedCardDetails | null {
  if (!row.card_ciphertext) return null;
  return JSON.parse(openSecret(row.card_ciphertext)) as DecryptedCardDetails;
}

export function listCardPurchases(owner: string, limit = 100): CardPurchaseRow[] {
  return db
    .prepare("SELECT * FROM card_purchases WHERE owner = ? ORDER BY created_at DESC LIMIT ?")
    .all(owner, limit) as CardPurchaseRow[];
}
