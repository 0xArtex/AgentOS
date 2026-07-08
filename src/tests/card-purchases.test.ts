/**
 * Card purchase state machine (services/card-purchases.ts).
 *
 * Money-critical: the agent's USDC settled BEFORE the job ran, and the job
 * spends OUR USDC upstream. Every branch must end in exactly one of: card
 * delivered, agent refunded, or deferred-with-oracle — never both keep the
 * money and fail to deliver, and never refund a card that exists. Deps are
 * injected so every branch (decline, ambiguous crash, orphan adoption,
 * stranded balance, expiry refund, recovery sweep, issuance ceilings) runs
 * deterministically with no Laso, chain, or treasury access.
 */
// Ceilings must be in env BEFORE config loads (node:test runs each file in
// its own process, so this can't leak into other suites).
process.env.LASO_DAILY_MAX_USD = "100";
process.env.LASO_AGENT_DAILY_MAX_USD = "50";
process.env.LASO_AGENT_DAILY_MAX_CARDS = "4";
process.env.LASO_CARD_FEE_PCT = "0.03";
process.env.LASO_CARD_FEE_MIN_USDC = "0.50";
if (!process.env.SECRETS_MASTER_KEY) process.env.ALLOW_INSECURE_SECRETS_KEY = "1";

import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { randomUUID } from "crypto";
import { db } from "../db";
import {
  cardFeeUsdc,
  cardPriceUsdc,
  validCardAmount,
  checkCardLimits,
  createCardPurchase,
  CardLimitError,
  runCardPurchase,
  pollUntilReady,
  reconcileCardPurchase,
  recoverStuckCardPurchases,
  getCardPurchase,
  decryptCardDetails,
  CardPurchaseDeps,
  CardPurchaseRow,
} from "../services/card-purchases";

const OWNER = "WALLET_cards_A";
const OWNER_B = "WALLET_cards_B";
const PAYER = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  db.prepare("DELETE FROM card_purchases").run();
});

// ─── Fixtures ───

function insertJob(over: Partial<CardPurchaseRow> = {}): string {
  const id = over.id ?? randomUUID();
  db.prepare(
    `INSERT INTO card_purchases
       (id, owner, payment_signature, payment_chain, charged_usdc, card_usd, fee_usdc, status,
        laso_card_id, payment_nonce, payment_valid_before, payer_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    over.owner ?? OWNER,
    over.payment_signature === undefined ? `sig-${id}` : over.payment_signature,
    over.payment_chain === undefined ? "base" : over.payment_chain,
    over.charged_usdc === undefined ? 20.6 : over.charged_usdc,
    over.card_usd ?? 20,
    over.fee_usdc ?? 0.6,
    over.status ?? "pending",
    over.laso_card_id ?? null,
    over.payment_nonce ?? null,
    over.payment_valid_before ?? null,
    over.payer_address ?? null,
    over.created_at ?? new Date().toISOString()
  );
  return id;
}

interface Calls {
  funded: number;
  buy: number;
  poll: number;
  list: number;
  consumed: number;
  balance: number;
  withdraw: number;
  refund: number;
  refundDashboard: number;
  lastFunded?: { owner: string; amountUsd: number };
  lastConsumedPayer?: string;
  lastRefund?: any;
  lastDashboardRefund?: any;
  lastWithdraw?: number;
}

const READY_DETAILS = {
  card_number: "4111222233334444",
  exp_month: "12",
  exp_year: "2028",
  cvv: "123",
  available_balance: 20,
};

function makeDeps(over: Partial<CardPurchaseDeps> = {}): { deps: CardPurchaseDeps; calls: Calls } {
  const calls: Calls = {
    funded: 0,
    buy: 0,
    poll: 0,
    list: 0,
    consumed: 0,
    balance: 0,
    withdraw: 0,
    refund: 0,
    refundDashboard: 0,
  };
  const baseFunded: CardPurchaseDeps["ensureFunded"] =
    over.ensureFunded ?? (async () => ({ address: PAYER, fundedUsdc: 20, fundingTx: "0xfund" }));
  const baseBuy: CardPurchaseDeps["buyCard"] =
    over.buyCard ??
    (async (_owner, amountUsd, onBeforePay) => {
      await onBeforePay({ nonce: "0x" + "aa".repeat(32), validBefore: Math.floor(Date.now() / 1000) + 600 });
      return {
        cardId: "laso-happy",
        status: "pending",
        usdAmount: amountUsd,
        lasoUserId: "0xuser",
        paidUsdc: amountUsd,
        raw: {},
      } as any;
    });
  const basePoll: CardPurchaseDeps["getCardData"] =
    over.getCardData ??
    (async (_owner, id) => ({ card_id: id, status: "ready", usd_amount: 20, card_details: READY_DETAILS }));
  const baseList = over.listCards ?? (async () => []);
  const baseConsumed = over.authorizationConsumed ?? (async () => false);
  const baseBalance = over.accountBalance ?? (async () => 0);
  const baseWithdraw = over.withdraw ?? (async () => {});
  const baseRefund = over.refund ?? (async () => ({ ok: true, refundId: "REF-1", refundTx: "0xr" }));
  const baseRefundDashboard = over.refundDashboard ?? (() => {});

  const deps: CardPurchaseDeps = {
    ensureFunded: (o, a) => {
      calls.funded++;
      calls.lastFunded = { owner: o, amountUsd: a };
      return baseFunded(o, a);
    },
    buyCard: (o, a, cb) => {
      calls.buy++;
      return baseBuy(o, a, cb);
    },
    getCardData: (o, id) => {
      calls.poll++;
      return basePoll(o, id);
    },
    listCards: (o) => {
      calls.list++;
      return baseList(o);
    },
    authorizationConsumed: (p, n) => {
      calls.consumed++;
      calls.lastConsumedPayer = p;
      return baseConsumed(p, n);
    },
    accountBalance: (o) => {
      calls.balance++;
      return baseBalance(o);
    },
    withdraw: (o, amt) => {
      calls.withdraw++;
      calls.lastWithdraw = amt;
      return baseWithdraw(o, amt);
    },
    refund: (o) => {
      calls.refund++;
      calls.lastRefund = o;
      return baseRefund(o);
    },
    refundDashboard: (uid, amt, ref, reason) => {
      calls.refundDashboard++;
      calls.lastDashboardRefund = { uid, amt, ref, reason };
      baseRefundDashboard(uid, amt, ref, reason);
    },
    payerAddressFor: over.payerAddressFor ?? (() => PAYER),
    pollIntervalMs: over.pollIntervalMs ?? 5,
    pollBudgetMs: over.pollBudgetMs ?? 400,
  };
  return { deps, calls };
}

// ─── Pricing ───

test("fee = max(3%, $0.50); price is amount+fee at integral cents", () => {
  assert.strictEqual(cardFeeUsdc(20), 0.6);
  assert.strictEqual(cardFeeUsdc(5), 0.5); // 3% would be $0.15 → floor wins
  assert.strictEqual(cardFeeUsdc(1000), 30);
  assert.strictEqual(cardPriceUsdc(20), 20.6);
  assert.strictEqual(cardPriceUsdc(5), 5.5);
  // price·1e6 must stay integral for the x402 challenge on oddball amounts
  for (const amt of [5, 7.77, 33.33, 123.45, 999.99, 1000]) {
    const p = cardPriceUsdc(amt) * 1e6;
    assert.ok(Math.abs(p - Math.round(p)) < 1e-6, `non-integral atomic price for ${amt}`);
  }
});

test("validCardAmount enforces bounds and integral cents", () => {
  assert.strictEqual(validCardAmount(5), true);
  assert.strictEqual(validCardAmount(1000), true);
  assert.strictEqual(validCardAmount(20.55), true);
  assert.strictEqual(validCardAmount(4.99), false);
  assert.strictEqual(validCardAmount(1000.01), false);
  assert.strictEqual(validCardAmount(5.001), false); // sub-cent
  assert.strictEqual(validCardAmount(NaN), false);
  assert.strictEqual(validCardAmount("20" as any), false);
});

// ─── Happy path ───

test("happy path: pending → purchasing → provisioning → ready, details encrypted at rest", async () => {
  const id = insertJob();
  const { deps, calls } = makeDeps();
  await runCardPurchase(id, deps);

  const job = getCardPurchase(id)!;
  assert.strictEqual(job.status, "ready");
  assert.strictEqual(job.laso_card_id, "laso-happy");
  assert.strictEqual(job.upstream_paid_usdc, 20);
  assert.strictEqual(job.last4, "4444");
  assert.strictEqual(job.available_balance, 20);
  assert.strictEqual(job.payer_address, PAYER); // the owner's own payer wallet
  assert.strictEqual(job.funding_tx, "0xfund"); // audit handle for the top-up
  assert.strictEqual(calls.funded, 1);
  assert.deepStrictEqual(calls.lastFunded, { owner: OWNER, amountUsd: 20 });
  assert.ok(job.payment_nonce!.startsWith("0x")); // persisted pre-send
  assert.ok(job.card_ciphertext!.startsWith("enc:v1:"));
  assert.ok(!job.card_ciphertext!.includes("4111")); // PAN not in plaintext
  assert.deepStrictEqual(decryptCardDetails(job), {
    card_number: READY_DETAILS.card_number,
    exp_month: "12",
    exp_year: "2028",
    cvv: "123",
  });
  assert.strictEqual(calls.refund, 0);
  assert.strictEqual(calls.buy, 1);
});

test("worker is idempotent: a non-pending job never re-buys", async () => {
  const id = insertJob({ status: "purchasing", payment_nonce: "0x" + "bb".repeat(32) });
  const { deps, calls } = makeDeps();
  await runCardPurchase(id, deps);
  assert.strictEqual(calls.buy, 0);
  assert.strictEqual(getCardPurchase(id)!.status, "purchasing");
});

// ─── Definitive decline ───

test("probe-level decline: failed + agent auto-refunded once", async () => {
  const id = insertJob();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { LasoDeclinedError } = require("../services/laso");
  const { deps, calls } = makeDeps({
    buyCard: async () => {
      throw new LasoDeclinedError(400, "amount too low");
    },
  });
  await runCardPurchase(id, deps);
  const job = getCardPurchase(id)!;
  assert.strictEqual(job.status, "failed");
  assert.strictEqual(job.error_code, "laso_declined");
  assert.strictEqual(job.refund_status, "sent");
  assert.strictEqual(calls.refund, 1);
  assert.strictEqual(calls.lastRefund.amountUsdc, 20.6); // full charge incl. fee
  assert.strictEqual(calls.lastRefund.chain, "base");
  assert.strictEqual(calls.lastRefund.originalPaymentSignature, `sig-${id}`);
});

// ─── Ambiguous outcomes → oracle-driven reconcile ───

function ambiguousBuy(validBeforeOffsetSec: number): CardPurchaseDeps["buyCard"] {
  return async (_owner, _amt, onBeforePay) => {
    await onBeforePay({
      nonce: "0x" + "cc".repeat(32),
      validBefore: Math.floor(Date.now() / 1000) + validBeforeOffsetSec,
    });
    const err: any = new Error("socket died after payment");
    err.ambiguous = true;
    throw err;
  };
}

// ─── Funding step ───

test("insolvent float → definitive failure + refund, buy never attempted", async () => {
  const id = insertJob();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CardFundingError } = require("../services/card-payer-wallets");
  const { deps, calls } = makeDeps({
    ensureFunded: async () => {
      throw new CardFundingError("float wallet holds $3 but $20 is needed", true);
    },
  });
  await runCardPurchase(id, deps);
  const job = getCardPurchase(id)!;
  assert.strictEqual(job.status, "failed");
  assert.strictEqual(job.error_code, "float_insufficient");
  assert.strictEqual(job.refund_status, "sent");
  assert.strictEqual(calls.buy, 0);
  assert.strictEqual(calls.refund, 1);
});

test("funding hiccup (RPC/transfer) → parked back to pending, NO refund; sweep re-runs to ready", async () => {
  const staleTs = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const id = insertJob({ created_at: staleTs });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CardFundingError } = require("../services/card-payer-wallets");
  let fundAttempts = 0;
  const { deps, calls } = makeDeps({
    ensureFunded: async () => {
      fundAttempts++;
      if (fundAttempts === 1) throw new CardFundingError("rpc down", false);
      return { address: PAYER, fundedUsdc: 20, fundingTx: "0xretry" };
    },
  });
  await runCardPurchase(id, deps);
  let job = getCardPurchase(id)!;
  assert.strictEqual(job.status, "pending"); // parked — money (if any moved) is in OUR wallet
  assert.strictEqual(job.error_code, "funding_retry");
  assert.strictEqual(calls.refund, 0);
  assert.strictEqual(calls.buy, 0);

  await recoverStuckCardPurchases(deps); // sweep re-runs; shortfall logic self-heals
  job = getCardPurchase(id)!;
  assert.strictEqual(job.status, "ready");
  assert.strictEqual(fundAttempts, 2);
  assert.strictEqual(calls.buy, 1);
});

test("ambiguous + unused nonce + window still open → deferred, NO refund", async () => {
  const id = insertJob();
  const { deps, calls } = makeDeps({ buyCard: ambiguousBuy(600) });
  await runCardPurchase(id, deps);
  const job = getCardPurchase(id)!;
  assert.strictEqual(job.status, "purchasing");
  assert.strictEqual(job.error_code, "reconcile_waiting_expiry");
  assert.strictEqual(calls.refund, 0);
});

test("ambiguous + unused nonce + window expired → provably unpaid → refund", async () => {
  const id = insertJob();
  const { deps, calls } = makeDeps({ buyCard: ambiguousBuy(-200) }); // already past + grace
  await runCardPurchase(id, deps);
  const job = getCardPurchase(id)!;
  assert.strictEqual(job.status, "failed");
  assert.strictEqual(job.error_code, "upstream_never_paid");
  assert.strictEqual(job.refund_status, "sent");
  assert.strictEqual(calls.refund, 1);
});

test("ambiguous + consumed nonce + orphan card upstream → adopt it, deliver, NO refund", async () => {
  const id = insertJob();
  const { deps, calls } = makeDeps({
    buyCard: ambiguousBuy(600),
    authorizationConsumed: async () => true,
    listCards: async () => [
      { card_id: "laso-orphan", status: "ready", usd_amount: 20, card_details: READY_DETAILS },
    ],
  });
  await runCardPurchase(id, deps);
  const job = getCardPurchase(id)!;
  assert.strictEqual(job.status, "ready");
  assert.strictEqual(job.laso_card_id, "laso-orphan");
  assert.strictEqual(calls.refund, 0);
  assert.ok(job.card_ciphertext!.startsWith("enc:v1:"));
});

test("orphan with a DIFFERENT amount is never adopted", async () => {
  const id = insertJob({ card_usd: 20 });
  const { deps, calls } = makeDeps({
    buyCard: ambiguousBuy(600),
    authorizationConsumed: async () => true,
    listCards: async () => [{ card_id: "laso-50", status: "ready", usd_amount: 50, card_details: READY_DETAILS }],
    accountBalance: async () => 0,
  });
  await runCardPurchase(id, deps);
  const job = getCardPurchase(id)!;
  assert.notStrictEqual(job.laso_card_id, "laso-50");
  assert.strictEqual(job.status, "purchasing"); // unresolved — defer, ops sees log
  assert.strictEqual(job.error_code, "reconcile_unresolved");
  assert.strictEqual(calls.refund, 0);
});

test("ambiguous + consumed + no card but balance credited → withdraw + refund agent", async () => {
  const id = insertJob();
  const { deps, calls } = makeDeps({
    buyCard: ambiguousBuy(600),
    authorizationConsumed: async () => true,
    listCards: async () => [],
    accountBalance: async () => 20,
  });
  await runCardPurchase(id, deps);
  const job = getCardPurchase(id)!;
  assert.strictEqual(job.status, "failed");
  assert.strictEqual(job.error_code, "upstream_settled_no_card");
  assert.strictEqual(calls.withdraw, 1);
  assert.strictEqual(calls.lastWithdraw, 20);
  assert.strictEqual(calls.refund, 1);
});

test("two crashed jobs, one orphan: exactly one adopts (atomic claim)", async () => {
  const nonce1 = "0x" + "d1".repeat(32);
  const nonce2 = "0x" + "d2".repeat(32);
  const id1 = insertJob({ status: "purchasing", payment_nonce: nonce1, payment_valid_before: Math.floor(Date.now() / 1000) + 600 });
  const id2 = insertJob({ status: "purchasing", payment_nonce: nonce2, payment_valid_before: Math.floor(Date.now() / 1000) + 600 });
  const { deps } = makeDeps({
    authorizationConsumed: async () => true,
    listCards: async () => [{ card_id: "laso-single", status: "ready", usd_amount: 20, card_details: READY_DETAILS }],
    accountBalance: async () => 0,
  });
  await reconcileCardPurchase(id1, deps, "test");
  await reconcileCardPurchase(id2, deps, "test");
  const adopted = [getCardPurchase(id1)!, getCardPurchase(id2)!].filter((j) => j.laso_card_id === "laso-single");
  assert.strictEqual(adopted.length, 1);
  assert.strictEqual(adopted[0].status, "ready");
});

// ─── Provisioning resilience ───

test("slow provisioning: budget exhausts without refund; a later sweep resumes and delivers", async () => {
  const id = insertJob({ status: "provisioning", laso_card_id: "laso-slow" });
  let pollCount = 0;
  const { deps, calls } = makeDeps({
    getCardData: async (cid) => {
      pollCount++;
      // stays pending well past the tiny budget…
      return { card_id: cid, status: "pending" };
    },
    pollIntervalMs: 5,
    pollBudgetMs: 40,
  });
  await pollUntilReady(id, deps);
  let job = getCardPurchase(id)!;
  assert.strictEqual(job.status, "provisioning"); // card exists — NEVER refund
  assert.strictEqual(job.error_code, "provisioning_slow");
  assert.strictEqual(calls.refund, 0);
  assert.ok(pollCount >= 2);

  // …then the issuer catches up and the sweep-resumed poll succeeds.
  const { deps: deps2 } = makeDeps();
  await pollUntilReady(id, deps2);
  job = getCardPurchase(id)!;
  assert.strictEqual(job.status, "ready");
  assert.strictEqual(job.error, null);
});

test("poll tolerates transient upstream errors within budget", async () => {
  const id = insertJob({ status: "provisioning", laso_card_id: "laso-flaky" });
  let n = 0;
  const { deps } = makeDeps({
    getCardData: async (cid) => {
      n++;
      if (n < 3) throw new Error("laso_auth_rejected:401");
      return { card_id: cid, status: "ready", card_details: READY_DETAILS };
    },
  });
  await pollUntilReady(id, deps);
  assert.strictEqual(getCardPurchase(id)!.status, "ready");
});

// ─── Crash recovery sweep ───

test("recovery sweep: stale pending re-runs, stale purchasing-with-card resumes, fresh rows untouched", async () => {
  const staleTs = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const stalePending = insertJob({ created_at: staleTs });
  const staleProvisioning = insertJob({ status: "provisioning", laso_card_id: "laso-happy", created_at: staleTs });
  const stalePurchasingWithCard = insertJob({
    status: "purchasing",
    laso_card_id: "laso-happy2",
    payment_nonce: "0x" + "ee".repeat(32),
    created_at: staleTs,
  });
  const freshPending = insertJob(); // now — under the stuck-age cutoff

  const { deps, calls } = makeDeps({
    getCardData: async (cid) => ({ card_id: cid, status: "ready", card_details: READY_DETAILS }),
  });
  await recoverStuckCardPurchases(deps);

  assert.strictEqual(getCardPurchase(stalePending)!.status, "ready"); // re-ran (safe: never signed)
  assert.strictEqual(getCardPurchase(staleProvisioning)!.status, "ready"); // resumed polling
  assert.strictEqual(getCardPurchase(stalePurchasingWithCard)!.status, "ready"); // card_id known → provision
  assert.strictEqual(getCardPurchase(freshPending)!.status, "pending"); // not stale — untouched
  assert.strictEqual(calls.buy, 1); // only the stale pending bought
  assert.strictEqual(calls.refund, 0);
});

test("purchasing with NO nonce: sweep re-runs it (nothing was ever signed); inline reconcile only parks it", async () => {
  const staleTs = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const id = insertJob({ status: "purchasing", payment_nonce: null, created_at: staleTs });
  const { deps, calls } = makeDeps();

  await reconcileCardPurchase(id, deps, "inline"); // inline: park as pending, no re-run
  assert.strictEqual(getCardPurchase(id)!.status, "pending");
  assert.strictEqual(calls.buy, 0);

  await recoverStuckCardPurchases(deps); // sweep: safe re-run to completion
  assert.strictEqual(getCardPurchase(id)!.status, "ready");
  assert.strictEqual(calls.buy, 1);
});

// ─── Refund plumbing ───

test("dashboard payer: failed purchase credits the internal balance, not the chain", async () => {
  const id = insertJob({ owner: "dashboard:user-7", payment_signature: null, payment_chain: null });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { LasoDeclinedError } = require("../services/laso");
  const { deps, calls } = makeDeps({
    buyCard: async () => {
      throw new LasoDeclinedError(400, "nope");
    },
  });
  await runCardPurchase(id, deps);
  const job = getCardPurchase(id)!;
  assert.strictEqual(job.status, "failed");
  assert.strictEqual(job.refund_status, "sent");
  assert.strictEqual(calls.refundDashboard, 1);
  assert.strictEqual(calls.refund, 0);
  assert.deepStrictEqual(
    { uid: calls.lastDashboardRefund.uid, amt: calls.lastDashboardRefund.amt, ref: calls.lastDashboardRefund.ref },
    { uid: "user-7", amt: 20.6, ref: id }
  );
});

test("missing payment context → manual_needed, never a blind on-chain refund", async () => {
  const id = insertJob({ payment_signature: null });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { LasoDeclinedError } = require("../services/laso");
  const { deps, calls } = makeDeps({
    buyCard: async () => {
      throw new LasoDeclinedError(400, "nope");
    },
  });
  await runCardPurchase(id, deps);
  assert.strictEqual(getCardPurchase(id)!.refund_status, "manual_needed");
  assert.strictEqual(calls.refund, 0);
});

// ─── Issuance ceilings (rolling 24h; global $100 / per-agent $50 in this suite) ───

test("limits: empty window allows a purchase at either bound", () => {
  assert.strictEqual(checkCardLimits(OWNER, 50).ok, true); // exactly the agent cap
  assert.strictEqual(checkCardLimits(OWNER, 50.01).ok, false); // a cent over
  assert.strictEqual(checkCardLimits(OWNER, 50.01).code, "daily_agent");
});

test("limits: per-agent cap counts only that agent; global cap counts everyone", () => {
  insertJob({ owner: OWNER, card_usd: 40, status: "ready" });
  // OWNER at $40/$50 → $15 breaches agent cap, $10 exactly fills it.
  assert.strictEqual(checkCardLimits(OWNER, 15).code, "daily_agent");
  assert.strictEqual(checkCardLimits(OWNER, 10).ok, true);
  // OWNER_B is clean on the agent cap but shares the global window.
  insertJob({ owner: OWNER_B, card_usd: 30, status: "ready" });
  assert.strictEqual(checkCardLimits(OWNER_B, 20).ok, true); // agent 50✓, global 90✓
  insertJob({ owner: "WALLET_cards_C", card_usd: 25, status: "ready" }); // global now 95
  const c = checkCardLimits(OWNER_B, 10); // agent fine (40), global 105 > 100
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.code, "daily_global");
});

test("limits: failed rows are excluded (agent was refunded)", () => {
  insertJob({ owner: OWNER, card_usd: 45, status: "failed" });
  assert.strictEqual(checkCardLimits(OWNER, 50).ok, true);
});

test("limits: rows older than 24h roll out of the window", () => {
  insertJob({ owner: OWNER, card_usd: 45, status: "ready", created_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() });
  assert.strictEqual(checkCardLimits(OWNER, 50).ok, true);
});

test("limits: in-flight reservations (pending/purchasing/provisioning) count", () => {
  insertJob({ owner: OWNER, card_usd: 20, status: "pending" });
  insertJob({ owner: OWNER, card_usd: 20, status: "purchasing" });
  const s = checkCardLimits(OWNER, 15);
  assert.strictEqual(s.code, "daily_agent"); // 40 reserved + 15 > 50
  assert.strictEqual(s.agentUsedUsd, 40);
});

test("per-agent card COUNT cap (issuer's 6/day, 4 in this suite): boundary allowed, next rejected", () => {
  // Three small cards — dollars are nowhere near the $50 agent cap.
  insertJob({ owner: OWNER, card_usd: 5, status: "ready" });
  insertJob({ owner: OWNER, card_usd: 5, status: "ready" });
  insertJob({ owner: OWNER, card_usd: 5, status: "pending" }); // in-flight counts
  const fourth = checkCardLimits(OWNER, 5);
  assert.strictEqual(fourth.ok, true); // 3 + 1 = 4 = cap, allowed
  insertJob({ owner: OWNER, card_usd: 5, status: "ready" });
  const fifth = checkCardLimits(OWNER, 5);
  assert.strictEqual(fifth.ok, false);
  assert.strictEqual(fifth.code, "daily_agent_cards");
  assert.strictEqual(fifth.agentUsedCards, 4);
  assert.strictEqual(fifth.agentMaxCards, 4);
});

test("card COUNT cap: failed rows and other agents don't count", () => {
  for (let i = 0; i < 4; i++) insertJob({ owner: OWNER, card_usd: 5, status: "failed" });
  for (let i = 0; i < 4; i++) insertJob({ owner: OWNER_B, card_usd: 5, status: "ready" });
  assert.strictEqual(checkCardLimits(OWNER, 5).ok, true); // 4 failed + B's 4 don't count against OWNER
});

test("card COUNT cap enforced transactionally at reservation", () => {
  for (let i = 0; i < 4; i++) insertJob({ owner: OWNER, card_usd: 5, status: "ready" });
  const { deps } = makeDeps();
  assert.throws(
    () =>
      createCardPurchase(
        { owner: OWNER, paymentSignature: "sig-c", paymentChain: "base", chargedUsdc: 5.5, cardUsd: 5, feeUsdc: 0.5 },
        deps
      ),
    (e: any) => e instanceof CardLimitError && e.limit.code === "daily_agent_cards"
  );
  const count = (db.prepare("SELECT COUNT(*) AS c FROM card_purchases WHERE owner = ?").get(OWNER) as any).c;
  assert.strictEqual(count, 4); // no fifth row
});

test("reservation is transactional: over-cap insert throws CardLimitError and leaves no row", async () => {
  insertJob({ owner: OWNER_B, card_usd: 90, status: "ready" }); // global at 90/100
  const { deps } = makeDeps();
  assert.throws(
    () =>
      createCardPurchase(
        { owner: OWNER, paymentSignature: "sig-x", paymentChain: "base", chargedUsdc: 20.6, cardUsd: 20, feeUsdc: 0.6 },
        deps
      ),
    (e: any) => e instanceof CardLimitError && e.limit.code === "daily_global"
  );
  const count = (db.prepare("SELECT COUNT(*) AS c FROM card_purchases WHERE owner = ?").get(OWNER) as any).c;
  assert.strictEqual(count, 0);
});

test("reservation at the exact boundary succeeds and the worker delivers", async () => {
  insertJob({ owner: OWNER_B, card_usd: 80, status: "ready" }); // global 80/100
  const { deps } = makeDeps();
  const job = createCardPurchase(
    { owner: OWNER, paymentSignature: "sig-y", paymentChain: "base", chargedUsdc: 20.6, cardUsd: 20, feeUsdc: 0.6 },
    deps
  );
  assert.strictEqual(job.status, "pending");
  // Worker was scheduled via setImmediate with OUR fake deps — let it finish.
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(getCardPurchase(job.id)!.status, "ready");
});
