/**
 * The agent-to-agent resale marketplace — a top-level `/market` surface, not
 * tied to any one platform.
 *
 * An agent that owns an UNREVEALED account lists it, another agent buys it,
 * ownership + the live server session transfer, and the seller is paid
 * (price − fee) via the treasury payout pipeline. `platform` is a request
 * parameter, so X / email / phone slot in behind these same routes as they
 * gain the sealed-account model — this is why it's `/market`, not `/social/*`.
 * Wallet-to-wallet: the seller must be a wallet to receive the payout. Fee is
 * env-configurable.
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { requireSocialReady } from "../middleware/social-ready";
import { AuthenticatedRequest } from "../types";
import { refundAndRespond, refundUsdcToPayer } from "../services/refund";
import {
  listForSale as listTikTokForSale,
  unlist as unlistTikTok,
  marketListings as tiktokMarketListings,
  buyFromMarket as buyTikTokFromMarket,
  getAccount as getTikTokAccount,
} from "../services/tiktok-accounts";

const router = Router();

// A Base (0x…) or Solana (base58) wallet address — the seller must be one to
// receive the on-chain payout.
const WALLET_ADDR_RE = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
// Platform take on a resale, in basis points (default 1000 = 10%). Clamped to
// [0, 5000] so a misconfig can never pay a seller a negative amount.
const RESALE_FEE_BPS = Math.min(5000, Math.max(0, Number(process.env.PALMYR_RESALE_FEE_BPS ?? 1000) || 0));

// Platform adapters — TikTok is the only marketplace platform today; X / email
// slot in here. Anything else = "not on the marketplace yet".
function marketListFor(platform: string, id: string, owner: string, price: number): { ok: boolean; error?: string } {
  if (platform === "tiktok") return listTikTokForSale(id, owner, price);
  return { ok: false, error: `platform "${platform}" is not on the marketplace yet` };
}
function marketUnlistFor(platform: string, id: string, owner: string): { ok: boolean; error?: string } {
  if (platform === "tiktok") return unlistTikTok(id, owner);
  return { ok: false, error: `platform "${platform}" is not on the marketplace yet` };
}
function marketListingsFor(platform: string | undefined, country?: string): Array<Record<string, unknown>> {
  // No platform → aggregate across all (only tiktok exists today).
  const out: Array<Record<string, unknown>> = [];
  if (!platform || platform === "tiktok") {
    for (const l of tiktokMarketListings({ country })) out.push({ platform: "tiktok", ...l });
  }
  return out;
}
function marketPriceFor(platform: string, id: string): number {
  if (platform === "tiktok") return getTikTokAccount(id)?.list_price_usdc ?? 0;
  return 0;
}
function marketBuyFor(platform: string, buyer: string, id: string): { ok: boolean; error?: string; ownListing?: boolean; seller?: string; price_usdc?: number } {
  if (platform === "tiktok") return buyTikTokFromMarket(buyer, id);
  return { ok: false, error: `platform "${platform}" is not on the marketplace yet` };
}

// GET /market/listings?platform=&country= — public browse (all platforms if none).
router.get("/listings", (req: Request, res: Response) => {
  const platform = typeof req.query.platform === "string" ? req.query.platform : undefined;
  const country = typeof req.query.country === "string" ? req.query.country : undefined;
  const listings = marketListingsFor(platform, country);
  res.json({ count: listings.length, fee_bps: RESALE_FEE_BPS, listings });
});

// POST /market/list { platform, account_id, price_usdc } — owner lists for resale.
router.post(
  "/list",
  requireSocialReady,
  requireAuth(0.001, "general", { description: "List an account you own for resale on the marketplace. Body: { platform, account_id, price_usdc }. Only unrevealed, active accounts can be listed; the seller must be a wallet to receive the payout.", category: "marketplace", tags: ["marketplace", "list", "sell"] }),
  (req: AuthenticatedRequest, res: Response) => {
    const { platform, account_id, price_usdc } = (req.body || {}) as { platform?: string; account_id?: string; price_usdc?: number };
    if (!platform) { res.status(400).json({ error: "platform required" }); return; }
    if (!account_id) { res.status(400).json({ error: "account_id required" }); return; }
    if (typeof price_usdc !== "number" || !(price_usdc > 0)) { res.status(400).json({ error: "price_usdc must be a positive number" }); return; }
    const owner = req.payment?.payer || req.agentId;
    if (!owner) { res.status(401).json({ error: "Unauthenticated" }); return; }
    if (!WALLET_ADDR_RE.test(String(owner))) {
      res.status(400).json({ error: "Wallet required", message: "Resale payouts are paid on-chain, so the account must be owned by a wallet. Own it via a wallet identity to list it." });
      return;
    }
    const result = marketListFor(String(platform), account_id, String(owner), price_usdc);
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
    const net = Math.round(price_usdc * (1 - RESALE_FEE_BPS / 10000) * 1_000_000) / 1_000_000;
    res.json({
      listed: true,
      platform,
      account_id,
      price_usdc,
      you_receive_usdc: net,
      fee_note: `A buyer pays ${price_usdc} USDC; you receive ${net} after the ${RESALE_FEE_BPS / 100}% platform fee.`,
    });
  },
);

// POST /market/unlist { platform, account_id } — owner withdraws a listing.
router.post(
  "/unlist",
  requireSocialReady,
  requireAuth(0.001, "general", { description: "Withdraw an account you listed for resale. Body: { platform, account_id }.", category: "marketplace", tags: ["marketplace", "unlist"] }),
  (req: AuthenticatedRequest, res: Response) => {
    const { platform, account_id } = (req.body || {}) as { platform?: string; account_id?: string };
    if (!platform) { res.status(400).json({ error: "platform required" }); return; }
    if (!account_id) { res.status(400).json({ error: "account_id required" }); return; }
    const owner = req.payment?.payer || req.agentId;
    if (!owner) { res.status(401).json({ error: "Unauthenticated" }); return; }
    const result = marketUnlistFor(String(platform), account_id, String(owner));
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
    res.json({ unlisted: true, platform, account_id });
  },
);

// The paywall needs the price before the handler runs, so read it off the listing.
function resolveMarketPrice(req: Request): number {
  const { platform, account_id } = (req.body || {}) as { platform?: string; account_id?: string };
  if (typeof platform !== "string" || typeof account_id !== "string") return 0; // validateMarketBuy 4xxs this
  return marketPriceFor(platform, account_id);
}

// Reject a buy for something that isn't listed BEFORE the paywall charges.
function validateMarketBuy(req: Request, res: Response, next: () => void): void {
  const { platform, account_id } = (req.body || {}) as { platform?: string; account_id?: string };
  if (typeof platform !== "string" || !platform) { res.status(400).json({ error: "platform required" }); return; }
  if (typeof account_id !== "string" || !account_id) { res.status(400).json({ error: "account_id required" }); return; }
  if (!(marketPriceFor(platform, account_id) > 0)) {
    res.status(404).json({ error: "Not for sale", message: `${platform} account ${account_id} is not currently listed. Browse GET /market/listings.` });
    return;
  }
  next();
}

// POST /market/buy { platform, account_id } — buy a listed account. Pay the
// listing price; ownership + the live session transfer to you, and the seller
// is paid (price − fee). The account arrives SEALED (drive it via ops; reveal
// to commit).
router.post(
  "/buy",
  requireSocialReady,
  validateMarketBuy,
  requireAuth(resolveMarketPrice, "general", { description: "Buy an account listed on the resale marketplace. Body: { platform, account_id }. You get ownership + the live server session — drive it immediately with that platform's ops.", category: "marketplace", tags: ["marketplace", "buy"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const { platform, account_id } = (req.body || {}) as { platform?: string; account_id?: string };
    const buyer = req.payment?.payer || req.agentId;
    if (!buyer) { res.status(400).json({ error: "No payer/agent identity" }); return; }
    const paidUsdc = req.payment ? Number(req.payment.amountLamports) / 1_000_000 : undefined;
    try {
      const result = marketBuyFor(String(platform), String(buyer), String(account_id));
      if (!result.ok) {
        const status = result.ownListing ? 400 : 409;
        if (req.payment) {
          await refundAndRespond(req, res, { reason: result.error || "buy failed", userMessage: (result.error || "Could not complete the purchase") + " — your payment is being refunded.", errorLabel: "Buy failed", httpStatus: status });
        } else {
          res.status(status).json({ error: result.error });
        }
        return;
      }

      // Pay the seller (price − fee). Reuses the refund pipeline (idempotent +
      // auto-retried on failure). Keyed on the buyer's payment signature when
      // present (x402), else a per-sale key (the account can only sell once, so
      // it's stable). The seller is always a wallet (enforced at list time).
      const seller = result.seller!;
      const price = result.price_usdc!;
      const sellerChain: "solana" | "base" = seller.startsWith("0x") ? "base" : "solana";
      const owed = Math.round(price * (1 - RESALE_FEE_BPS / 10000) * 1_000_000) / 1_000_000;
      const payoutKey = req.payment?.signature ?? `sale_${platform}_${account_id}_${buyer}`;
      let sellerPaid: { ok: boolean; tx?: string; owed: number } | null = null;
      try {
        const payout = await refundUsdcToPayer({
          chain: sellerChain,
          payer: seller,
          amountUsdc: owed,
          reason: `marketplace resale payout: ${platform} ${account_id} sold to ${buyer}`,
          originalPaymentSignature: payoutKey,
          endpoint: "/market/buy",
        });
        sellerPaid = { ok: payout.ok, tx: payout.refundTx, owed };
        if (!payout.ok) console.error(`[market] seller payout not sent for ${platform} ${account_id} (owed ${owed} to ${seller}): ${payout.reason} — refund sweep will retry`);
      } catch (e: any) {
        console.error(`[market] seller payout threw for ${platform} ${account_id} (owed ${owed} to ${seller}):`, e?.message || e);
        sellerPaid = { ok: false, owed };
      }

      res.status(200).json({
        bought: true,
        platform,
        account_id,
        owner: String(buyer),
        paid_usdc: paidUsdc ?? price,
        seller_payout: sellerPaid,
        message: `You now own this account and its live session — drive it with the ${platform} ops using this account_id. The raw login stays sealed unless you reveal it.`,
      });
    } catch (err: any) {
      if (req.payment) {
        await refundAndRespond(req, res, { reason: `Buy failed: ${err?.message || err}`, userMessage: "Could not complete the purchase — your payment is being refunded.", errorLabel: "Buy failed" });
      } else {
        res.status(500).json({ error: err.message || "Buy failed" });
      }
    }
  },
);

export default router;
