/**
 * /cards — prepaid Visa cards for agents (Laso Finance upstream).
 *
 * One x402 call buys a USA prepaid card loaded with EXACTLY the requested
 * balance: `POST /cards/buy {amount: 20}` → dynamic 402 for amount + fee →
 * 202 + poll → PAN/CVV/expiry retrievable via `GET /cards/:id` (~10s later).
 * US merchants only; non-reloadable; spend across transactions until depleted.
 *
 * Pricing is dynamic per-request (auth.ts function-form): the 402 challenge
 * advertises exactly `amount + max(pct·amount, min_fee)`. Like
 * /domains/register, the preflight middleware rejects doomed orders BEFORE
 * the paywall — bad amounts, feature disabled, issuance ceilings, payer float
 * — so a caller is never charged for a purchase that can't proceed.
 *
 * Reads follow the phone.ts ownership-proof convention ($0.01): the paying
 * wallet is the owner; card PAN/CVV are returned ONLY on the owner-verified
 * `GET /cards/:id`, never on the free unauthenticated poll.
 */
import { Router, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { refundAndRespond } from "../services/refund";
import { config } from "../config";
import { lasoGetCardData, lasoRefreshCardData, getLasoIdToken } from "../services/laso";
import { lasoEnabled, floatUsdcBalance, payerAuthCtx } from "../services/card-payer-wallets";
import {
  cardPriceUsdc,
  cardFeeUsdc,
  validCardAmount,
  checkCardLimits,
  createCardPurchase,
  getCardPurchase,
  listCardPurchases,
  decryptCardDetails,
  ensureBillingAddress,
  CardLimitError,
} from "../services/card-purchases";
import { extractClaimedSvmPayer } from "../middleware/x402-svm-verify";

const router = Router();

// Symbolic fee proving the signing wallet controls the resource — same
// "ownership proof" tier as phone numbers, domains and X accounts.
const OWNERSHIP_PROOF_USDC = 0.01;

const CARD_BUY_META = {
  description:
    "Buy a USA prepaid Visa card loaded with exactly the requested balance ($5–$1000). " +
    "Price is dynamic: amount + fee (3% min $0.50) — send unpaid to get a 402 with the exact total. " +
    "Body: { amount }. Returns 202 + poll_url; card number/CVV via GET /cards/:id when ready (~10s). " +
    "US merchants only; non-reloadable.",
  category: "cards",
  tags: ["card", "prepaid", "visa", "payments"],
};
// Representative price for discovery probes (a $20 card). Real callers get
// the exact per-amount price from their own 402.
const CARD_BUY_TYPICAL_USDC = cardPriceUsdc(20);

/**
 * Best-effort claimed-payer extraction BEFORE settlement, so the per-agent
 * ceiling can reject pre-charge on the paid retry. Spoofing gains nothing:
 * the x402 verifier still runs before settlement, and createCardPurchase
 * re-checks the ceilings with the VERIFIED owner inside a transaction.
 */
function claimedPayer(req: AuthenticatedRequest): string | null {
  const raw = (req.headers["x-payment"] || req.headers["payment-signature"]) as string | undefined;
  if (!raw) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    const evmFrom = decoded?.payload?.authorization?.from;
    if (typeof evmFrom === "string" && evmFrom) return evmFrom;
  } catch {
    /* fall through */
  }
  return extractClaimedSvmPayer(String(raw));
}

/**
 * Preflight + dynamic pricing gate for /cards/buy (domains.ts pattern).
 * Everything here runs BEFORE any USDC moves — every rejection carries
 * "wallet NOT charged".
 */
async function requireCardPayment(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const hasPayment = !!(req.headers["payment-signature"] || req.headers["x-payment"]);

  // Discovery probe (empty body, no payment): issue a representative 402 so
  // crawlers can index the route. Real callers fall through to exact pricing.
  if (!hasPayment && req.body?.amount === undefined) {
    return requireAuth(CARD_BUY_TYPICAL_USDC, "general", CARD_BUY_META)(req, res, next);
  }

  if (!lasoEnabled()) {
    res.status(503).json({
      error: "Card issuance is not enabled on this deployment",
      error_code: "cards_disabled",
      hint: "Your wallet has NOT been charged.",
    });
    return;
  }

  const amount = Number(req.body?.amount);
  if (!validCardAmount(amount)) {
    res.status(400).json({
      error: `amount must be a number between $${config.lasoMinCardUsd} and $${config.lasoMaxCardUsd} with at most 2 decimals`,
      error_code: "invalid_amount",
      hint: "Your wallet has NOT been charged. Example body: { \"amount\": 20 }",
    });
    return;
  }

  // Issuance ceilings. Global is identity-free; per-agent uses the claimed
  // payer when one is derivable pre-settlement (authoritative re-check happens
  // post-settlement inside createCardPurchase's transaction).
  const payer = claimedPayer(req) || req.agentId || "";
  const limits = checkCardLimits(payer || "anonymous-preflight", amount);
  const agentScoped = limits.code === "daily_agent" || limits.code === "daily_agent_cards";
  const limitBreached = !limits.ok && (limits.code === "daily_global" || (agentScoped && !!payer));
  if (limitBreached) {
    res.setHeader("Retry-After", "3600");
    res.status(429).json({
      error:
        limits.code === "daily_agent_cards"
          ? "Per-agent 24h card count limit reached (issuer allows a fixed number of cards per account per day)"
          : limits.code === "daily_agent"
            ? "Per-agent 24h card issuance limit reached"
            : "Global 24h card issuance limit reached",
      error_code: limits.code,
      ...(limits.code === "daily_agent_cards"
        ? { limit_cards: limits.agentMaxCards, used_cards: limits.agentUsedCards }
        : {
            limit_usd: limits.code === "daily_agent" ? limits.agentMaxUsd : limits.globalMaxUsd,
            used_usd: limits.code === "daily_agent" ? limits.agentUsedUsd : limits.globalUsedUsd,
          }),
      retry_after_seconds: 3600,
      hint: "Your wallet has NOT been charged. The window is rolling 24h.",
    });
    return;
  }

  // Operator float: refuse orders the float wallet can't fund. (Per-agent
  // payer wallets are topped up just-in-time from this float — see
  // card-payer-wallets.ts.) Unknown float (RPC blip) proceeds — the job
  // reconciles safely either way.
  const float = await floatUsdcBalance();
  if (float != null && float < amount) {
    console.error(`[cards] payer float too low: have $${float}, need $${amount}`);
    res.setHeader("Retry-After", "300");
    res.status(503).json({
      error: "Card issuance temporarily unavailable — try again shortly",
      error_code: "issuer_float_low",
      retry_after_seconds: 300,
      hint: "Your wallet has NOT been charged. This is an operator-side float issue; ops has been pinged via server logs.",
    });
    return;
  }

  const price = cardPriceUsdc(amount);
  // Stash for the handler: dashboard payers have no req.payment, so the
  // handler records THIS as the charge to credit back if the job fails.
  res.locals.cardBuyPriceUsdc = price;
  res.locals.cardAmountUsd = amount;
  return requireAuth(price, "general", CARD_BUY_META)(req, res, next);
}

// Discovery markers (domains.ts pattern): the priced layer is created at
// request time, so tag the middleware itself for route-discovery's walker.
(requireCardPayment as any)._x402PaidMin = CARD_BUY_TYPICAL_USDC;
(requireCardPayment as any)._x402ServiceType = "general";
(requireCardPayment as any)._x402Metadata = CARD_BUY_META;
(requireCardPayment as any)._x402DynamicPrice = true;

/**
 * POST /cards/buy — body { amount }
 */
router.post("/buy", requireCardPayment, async (req: AuthenticatedRequest, res: Response) => {
  const amount: number = res.locals.cardAmountUsd ?? Number(req.body?.amount);
  if (!validCardAmount(amount)) {
    // Only reachable via the discovery-probe path (which never settles).
    res.status(400).json({ error: "amount is required", error_code: "invalid_amount" });
    return;
  }

  const owner = req.payment?.payer || req.agentId || "unknown";
  const paymentSignature = req.payment?.signature || null;
  const paymentChain = req.payment?.chain || null;
  const reservedPrice = typeof res.locals.cardBuyPriceUsdc === "number" ? res.locals.cardBuyPriceUsdc : null;
  const chargedUsdc = req.payment ? Number(req.payment.amountLamports) / 1_000_000 : reservedPrice;

  let job;
  try {
    job = createCardPurchase({
      owner,
      paymentSignature,
      paymentChain,
      chargedUsdc,
      cardUsd: amount,
      feeUsdc: cardFeeUsdc(amount),
    });
  } catch (e: any) {
    if (e instanceof CardLimitError) {
      // Lost the reservation race after settlement — make the payer whole.
      await refundAndRespond(req, res, {
        reason: `issuance ceiling hit at reservation: ${e.limit.code}`,
        httpStatus: 429,
        errorLabel: "Card issuance limit reached",
        userMessage:
          "The 24h issuance ceiling was reached while your payment settled. Your payment is being refunded automatically.",
        extra: { error_code: e.limit.code, retry_after_seconds: 3600 },
      });
      return;
    }
    console.error("[cards] could not start purchase job — auto-refunding", { owner, error: e?.message || String(e) });
    await refundAndRespond(req, res, {
      reason: `could not start card purchase: ${e?.message || e}`,
      httpStatus: 500,
      errorLabel: "Could not start card purchase",
      userMessage: "We could not start your card purchase. Your payment is being refunded automatically.",
    });
    return;
  }

  res.status(202).json({
    operation_id: job.id,
    card_id: job.id,
    status: job.status,
    poll_url: `/cards/operations/${job.id}`,
    poll_after_seconds: 3,
    pricing: { card_usd: job.card_usd, fee_usdc: job.fee_usdc, charged_usdc: job.charged_usdc },
    message:
      "Card purchase started — typically ready in ~10s. Poll poll_url until done, then fetch the card number " +
      "via GET /cards/:id (ownership-verified). Do not resubmit — payment is already captured; " +
      "failures are refunded automatically.",
  });
});

/**
 * GET /cards/operations/:id — free poll (capability URL, social.ts model).
 * Carries status/refund state and the card's non-sensitive display fields
 * once ready — NEVER the PAN/CVV.
 */
function pollerMayRead(req: AuthenticatedRequest, owner: string): boolean {
  const identity = req.payment?.payer || req.agentId;
  return !identity || identity === owner;
}

router.get("/operations/:id", (req: AuthenticatedRequest, res: Response) => {
  const job = getCardPurchase(String(req.params.id || ""));
  if (!job || !pollerMayRead(req, job.owner)) {
    res.status(404).json({ error: "Operation not found" });
    return;
  }
  // Deliberately NO card data here beyond status — not even last4/balance.
  // This route is free + unauthenticated (capability URL), so if the id ever
  // leaks (explorer indexing, logs, referrers) the leak reveals only that a
  // purchase of $X exists. Card fields live behind the owner-verified read.
  res.json({
    operation_id: job.id,
    card_id: job.id,
    status: job.status,
    done: job.status === "ready" || job.status === "failed",
    card_usd: job.card_usd,
    fee_usdc: job.fee_usdc,
    cost: job.charged_usdc,
    detail_url: job.status === "ready" ? `/cards/${job.id}` : null,
    poll_url: `/cards/operations/${job.id}`,
    error: job.error,
    error_code: job.error_code,
    refund_status: job.refund_status,
    created_at: job.created_at,
    ready_at: job.ready_at,
    completed_at: job.completed_at,
    hint:
      job.status === "ready"
        ? "Fetch the card number/CVV via GET /cards/:id (owner-verified, $0.01 ownership proof)."
        : undefined,
  });
});

/**
 * GET /cards — list the caller's cards (no PAN/CVV; $0.01 ownership proof).
 */
router.get(
  "/",
  requireAuth(OWNERSHIP_PROOF_USDC, "general", {
    description:
      "List your prepaid cards (status, last4, balance — never full card numbers; those are per-card via GET /cards/:id).",
    category: "cards",
    tags: ["card", "list"],
  }),
  (req: AuthenticatedRequest, res: Response) => {
    const caller = req.payment?.payer || req.agentId;
    if (!caller) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const rows = listCardPurchases(caller);
    res.json({
      owner: caller,
      count: rows.length,
      cards: rows.map((r) => ({
        card_id: r.id,
        status: r.status,
        card_usd: r.card_usd,
        fee_usdc: r.fee_usdc,
        last4: r.last4,
        available_balance: r.available_balance,
        error_code: r.error_code,
        refund_status: r.refund_status,
        created_at: r.created_at,
        ready_at: r.ready_at,
      })),
    });
  }
);

/**
 * GET /cards/:id — full card details (PAN/CVV/expiry), owner only.
 */
router.get(
  "/:id",
  requireAuth(OWNERSHIP_PROOF_USDC, "general", {
    description:
      "Retrieve a prepaid card you own: full card number, CVV, expiry, balance. Owner-verified ($0.01 ownership proof).",
    category: "cards",
    tags: ["card", "details"],
    // Per-id paid route: every settle would otherwise register the CONCRETE
    // /cards/<uuid> URL on the Bazaar/x402scan explorers — publishing the
    // capability id the free poll route trusts. Reachable via the buy flow's
    // detail_url instead of the catalog.
    discoverable: false,
  }),
  async (req: AuthenticatedRequest, res: Response) => {
    const caller = req.payment?.payer || req.agentId;
    const job = getCardPurchase(String(req.params.id || ""));
    if (!job || !caller || job.owner !== caller) {
      res.status(404).json({ error: "Card not found" });
      return;
    }
    if (job.status !== "ready") {
      res.json({
        card_id: job.id,
        status: job.status,
        done: job.status === "failed",
        card_usd: job.card_usd,
        poll_url: `/cards/operations/${job.id}`,
        error: job.error,
        error_code: job.error_code,
        refund_status: job.refund_status,
        hint:
          job.status === "failed"
            ? "This purchase failed — the payment was refunded automatically (see refund_status)."
            : "Card not ready yet — poll poll_url until status is 'ready'.",
      });
      return;
    }
    let details;
    try {
      details = decryptCardDetails(job);
    } catch (e: any) {
      console.error("[cards] decrypt failed", { cardId: job.id, error: e?.message || String(e) });
      res.status(500).json({
        error: "Card details are stored but could not be decrypted",
        hint: "Operator-side key issue (SECRETS_MASTER_KEY) — contact support.",
      });
      return;
    }
    // Cards issued before we persisted it self-heal on first read.
    const billing = details ? await ensureBillingAddress(job, details) : null;

    res.json({
      card_id: job.id,
      status: "ready",
      network: "visa_prepaid_us",
      // { card_number, exp_month, exp_year, cvv, billing_address }
      card: details ? { ...details, billing_address: billing ?? undefined } : null,
      last4: job.last4,
      card_usd: job.card_usd,
      available_balance: job.available_balance,
      usage:
        "USA merchants only (USD). Non-reloadable: spend across any number of transactions until the balance is depleted. " +
        "Works at online checkouts accepting Visa prepaid; physical goods must ship to a U.S. address. " +
        "When a checkout asks for a billing address or ZIP, use card.billing_address — the card is issued to the " +
        "issuer's address (name is always 'Laso Finance'), and there is no way to register your own.",
      created_at: job.created_at,
      ready_at: job.ready_at,
      refresh_url: `/cards/${job.id}/refresh`,
    });
  }
);

/**
 * POST /cards/:id/refresh — live balance + transactions from the issuer.
 * Upstream rate-limits re-scrapes (1/5min per card, 24/day) — a 429 from
 * here means "ask again in a few minutes".
 */
router.post(
  "/:id/refresh",
  requireAuth(OWNERSHIP_PROOF_USDC, "general", {
    description:
      "Refresh a card's live balance and transactions from the issuer (rate-limited upstream: 1 per 5 min per card).",
    category: "cards",
    tags: ["card", "balance", "transactions"],
    discoverable: false, // per-id settles must not register concrete URLs
  }),
  async (req: AuthenticatedRequest, res: Response) => {
    const caller = req.payment?.payer || req.agentId;
    const job = getCardPurchase(String(req.params.id || ""));
    if (!job || !caller || job.owner !== caller) {
      res.status(404).json({ error: "Card not found" });
      return;
    }
    if (job.status !== "ready" || !job.laso_card_id) {
      res.status(409).json({
        error: "Card is not ready yet",
        status: job.status,
        poll_url: `/cards/operations/${job.id}`,
      });
      return;
    }
    try {
      const idToken = await getLasoIdToken(payerAuthCtx(job.owner));
      // Best-effort re-scrape request; the follow-up read returns whatever the
      // issuer currently has even when the re-scrape was rate-limited.
      const refresh = await lasoRefreshCardData(job.laso_card_id, idToken);
      const data = await lasoGetCardData(job.laso_card_id, idToken);
      const balance =
        typeof data.card_details?.available_balance === "number"
          ? data.card_details.available_balance
          : job.available_balance;
      const { db } = require("../db");
      db.prepare("UPDATE card_purchases SET available_balance = ? WHERE id = ?").run(balance, job.id);
      res.json({
        card_id: job.id,
        available_balance: balance,
        billing_address: data.card_details?.billing_address,
        transactions: data.transactions || [],
        refresh_accepted: refresh.status >= 200 && refresh.status < 300,
        refresh_status: refresh.status,
        last_updated_timestamp: data.last_updated_timestamp,
        hint:
          refresh.status === 429 || refresh.status === 409
            ? "Issuer re-scrape is rate-limited (1 per 5 min per card) — balance shown is the latest cached value."
            : undefined,
      });
    } catch (e: any) {
      console.error("[cards] refresh failed", { cardId: job.id, error: e?.message || String(e) });
      res.status(502).json({ error: "Issuer refresh failed — try again shortly", detail: String(e?.message || e) });
    }
  }
);

export default router;
// Exported for tests: the pre-paywall gate is where "never charge for a
// doomed order" lives, so it gets direct unit coverage.
export { requireCardPayment };
